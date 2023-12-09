import * as vscode from 'vscode'

import { ContextGroup, ContextStatusProvider } from '@sourcegraph/cody-shared/src/codebase-context/context-status'
import { LocalEmbeddingsFetcher } from '@sourcegraph/cody-shared/src/local-context'
import { isDotCom } from '@sourcegraph/cody-shared/src/sourcegraph-api/environments'
import { EmbeddingsSearchResult } from '@sourcegraph/cody-shared/src/sourcegraph-api/graphql/client'

import { spawnBfg } from '../graph/bfg/spawn-bfg'
import { QueryResultSet } from '../jsonrpc/embeddings-protocol'
import { MessageHandler } from '../jsonrpc/jsonrpc'
import { logDebug } from '../log'
import { captureException } from '../services/sentry/sentry'

export function createLocalEmbeddingsController(
    context: vscode.ExtensionContext,
    config: LocalEmbeddingsConfig
): LocalEmbeddingsController {
    return new LocalEmbeddingsController(context, config)
}

export interface LocalEmbeddingsConfig {
    testingLocalEmbeddingsModel: string | undefined
    testingLocalEmbeddingsEndpoint: string | undefined
    testingLocalEmbeddingsIndexLibraryPath: string | undefined
}

function getIndexLibraryPaths(): { indexPath: string; appIndexPath?: string } {
    switch (process.platform) {
        case 'darwin':
            return {
                indexPath: `${process.env.HOME}/Library/Caches/com.sourcegraph.cody/embeddings`,
                appIndexPath: `${process.env.HOME}/Library/Caches/com.sourcegraph.cody/blobstore/buckets/embeddings`,
            }
        case 'linux':
            return {
                indexPath: `${process.env.HOME}/.cache/com.sourcegraph.cody/embeddings`,
                appIndexPath: `${process.env.HOME}/.cache/com.sourcegraph.cody/blobstore/buckets/embeddings`,
            }
        case 'win32':
            return {
                indexPath: `${process.env.LOCALAPPDATA}\\com.sourcegraph.cody\\embeddings`,
                // Note, there was no Cody App on Windows, so we do not search for App indexes.
            }
        default:
            throw new Error(`Unsupported platform: ${process.platform}`)
    }
}

interface RepoState {
    indexable: boolean
    isGit: boolean
    hasIndex: boolean
}

export class LocalEmbeddingsController implements LocalEmbeddingsFetcher, ContextStatusProvider, vscode.Disposable {
    private disposables: vscode.Disposable[] = []

    // These properties are constants, but may be overridden for testing.
    private readonly model: string
    private readonly endpoint: string
    private readonly indexLibraryPath: string | undefined

    private service: Promise<MessageHandler> | undefined
    private serviceStarted = false
    private accessToken: string | undefined
    private endpointIsDotcom = false
    private statusBar: vscode.StatusBarItem | undefined
    private lastRepo: { path: string; loadResult: boolean } | undefined
    private repoState: Map<string, RepoState> = new Map()

    // If indexing is in progress, the path of the repo being indexed.
    private pathBeingIndexed: string | undefined

    // Fires when available local embeddings (may) have changed. This updates
    // the codebase context, which touches the network and file system, so only
    // use it for major changes like local embeddings being available at all,
    // or the first index for a repository coming online.
    private readonly changeEmitter = new vscode.EventEmitter<LocalEmbeddingsController>()

    constructor(
        private readonly context: vscode.ExtensionContext,
        config: LocalEmbeddingsConfig
    ) {
        logDebug('LocalEmbeddingsController', 'constructor')
        this.disposables.push(this.changeEmitter, this.statusEmitter)

        this.model = config.testingLocalEmbeddingsModel || 'openai/text-embedding-ada-002'
        this.endpoint = config.testingLocalEmbeddingsEndpoint || 'https://cody-gateway.sourcegraph.com/v1/embeddings'
        this.indexLibraryPath = config.testingLocalEmbeddingsIndexLibraryPath
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose()
        }
        this.statusBar?.dispose()
    }

    public get onChange(): vscode.Event<LocalEmbeddingsController> {
        return this.changeEmitter.event
    }

    // Hint that local embeddings should start cody-engine, if necessary.
    public async start(): Promise<void> {
        logDebug('LocalEmbeddingsController', 'start')
        await this.getService()
        const repoUri = vscode.workspace.workspaceFolders?.[0].uri
        if (repoUri) {
            await this.eagerlyLoad(repoUri.fsPath)
        }
    }

    public async setAccessToken(serverEndpoint: string, token: string | null): Promise<void> {
        const endpointIsDotcom = isDotCom(serverEndpoint)
        logDebug('LocalEmbeddingsController', 'setAccessToken', endpointIsDotcom ? 'is dotcom' : 'not dotcom')
        if (endpointIsDotcom !== this.endpointIsDotcom) {
            // We will show, or hide, status depending on whether we are using
            // dotcom. We do not offer local embeddings to Enterprise.
            this.statusEmitter.fire(this)
            if (this.serviceStarted) {
                this.changeEmitter.fire(this)
            }
        }
        this.endpointIsDotcom = endpointIsDotcom
        if (token === this.accessToken) {
            return Promise.resolve()
        }
        this.accessToken = token || undefined
        // TODO: Add a "drop token" for sign out
        if (token && this.serviceStarted) {
            await (await this.getService()).request('embeddings/set-token', token)
        }
    }

    private getService(): Promise<MessageHandler> {
        if (!this.service) {
            this.service = this.spawnAndBindService(this.context)
        }
        return this.service
    }

    private async spawnAndBindService(context: vscode.ExtensionContext): Promise<MessageHandler> {
        const service = await new Promise<MessageHandler>((resolve, reject) => {
            spawnBfg(context, reject).then(
                bfg => resolve(bfg),
                error => {
                    captureException(error)
                    reject(error)
                }
            )
        })
        // TODO: Add more states for cody-engine fetching and trigger status updates here
        service.registerNotification('embeddings/progress', obj => {
            if (!this.statusBar) {
                return
            }
            if (typeof obj === 'object') {
                // TODO: Make clicks on this status bar item show detailed status, errors.
                if ('Progress' in obj) {
                    const percent = Math.floor((100 * obj.Progress.numItems) / obj.Progress.totalItems)
                    this.statusBar.text = `$(loading~spin) Cody Embeddings (${percent.toFixed(0)}%)`
                    this.statusBar.backgroundColor = undefined
                    this.statusBar.tooltip = obj.Progress.currentPath
                    this.statusBar.show()
                } else if ('Error' in obj) {
                    this.statusBar.text = '$(warning) Cody Embeddings'
                    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
                    this.statusBar.tooltip = obj.Error
                    this.statusBar.show()
                }
            } else if (obj === 'Done') {
                this.statusBar.text = '$(sparkle) Cody Embeddings'
                this.statusBar.backgroundColor = undefined
                this.statusBar.show()

                // Hide this notification after a while.
                const statusBar = this.statusBar
                this.statusBar = undefined
                setTimeout(() => statusBar.hide(), 30_000)

                if (this.pathBeingIndexed && (!this.lastRepo || this.lastRepo.path === this.pathBeingIndexed)) {
                    const path = this.pathBeingIndexed
                    void (async () => {
                        const loadedOk = await this.eagerlyLoad(path)
                        logDebug('LocalEmbeddingsController', 'load after indexing "done"', path, loadedOk)
                        this.changeEmitter.fire(this)
                    })()
                }

                this.pathBeingIndexed = undefined
                this.statusEmitter.fire(this)
            } else {
                // TODO(dpc): Handle these notifications.
                logDebug('LocalEmbeddingsController', JSON.stringify(obj))
                void vscode.window.showInformationMessage(JSON.stringify(obj))
            }
        })

        logDebug('LocalEmbeddingsController', 'spawnAndBindService', 'service started, initializing')
        const paths = getIndexLibraryPaths()
        // Tests may override the index library path
        logDebug('LocalEmbeddingsController', 'spawnAndBindService', 'index library paths', JSON.stringify(paths))
        if (this.indexLibraryPath) {
            logDebug(
                'LocalEmbeddingsController',
                'spawnAndBindService',
                'overriding index library path',
                this.indexLibraryPath
            )
            paths.indexPath = this.indexLibraryPath
        }
        const initResult = await service.request('embeddings/initialize', {
            codyGatewayEndpoint: this.endpoint,
            ...paths,
        })
        logDebug(
            'LocalEmbeddingsController',
            'spawnAndBindService',
            'initialized',
            initResult,
            'token available?',
            !!this.accessToken
        )

        if (this.accessToken) {
            // Set the initial access token
            await service.request('embeddings/set-token', this.accessToken)
        }
        this.serviceStarted = true
        this.changeEmitter.fire(this)
        return service
    }

    // ContextStatusProvider implementation

    private statusEmitter: vscode.EventEmitter<ContextStatusProvider> = new vscode.EventEmitter()

    public onDidChangeStatus(callback: (provider: ContextStatusProvider) => void): vscode.Disposable {
        return this.statusEmitter.event(callback)
    }

    public get status(): ContextGroup[] {
        logDebug('LocalEmbeddingsController', 'get status')
        if (!this.endpointIsDotcom) {
            // There are no local embeddings for Enterprise.
            return []
        }
        // TODO: Summarize the path with ~, etc.
        const path = this.lastRepo?.path || vscode.workspace.workspaceFolders?.[0].uri.fsPath || '(No workspace loaded)'
        if (!this.lastRepo) {
            return [
                {
                    name: path,
                    providers: [
                        {
                            kind: 'embeddings',
                            type: 'local',
                            state: 'indeterminate',
                        },
                    ],
                },
            ]
        }
        if (this.pathBeingIndexed === path) {
            return [
                {
                    name: path,
                    providers: [{ kind: 'embeddings', type: 'local', state: 'indexing' }],
                },
            ]
        }
        if (this.lastRepo.loadResult) {
            return [
                {
                    name: path,
                    providers: [
                        {
                            kind: 'embeddings',
                            type: 'local',
                            state: 'ready',
                        },
                    ],
                },
            ]
        }
        const repoState = this.repoState.get(path)
        if (!repoState?.isGit) {
            return []
        }
        return [
            {
                name: path,
                providers: [
                    {
                        kind: 'embeddings',
                        type: 'local',
                        state: repoState?.indexable ? 'unconsented' : 'no-match',
                    },
                ],
            },
        ]
    }

    // Interactions with cody-engine

    public async index(): Promise<void> {
        if (!(this.endpointIsDotcom && this.lastRepo?.path && !this.lastRepo?.loadResult)) {
            // TODO: Support index updates.
            logDebug('LocalEmbeddingsController', 'index: No repository to index/already indexed')
            return
        }
        const repoPath = this.lastRepo.path
        logDebug('LocalEmbeddingsController', 'index: Starting repository', repoPath)
        try {
            await (
                await this.getService()
            ).request('embeddings/index', { path: repoPath, model: this.model, dimension: 1536 })
            this.pathBeingIndexed = repoPath
            this.statusBar?.dispose()
            this.statusBar = vscode.window.createStatusBarItem(
                'cody-local-embeddings',
                vscode.StatusBarAlignment.Right,
                0
            )
            this.statusEmitter.fire(this)
        } catch (error) {
            logDebug('LocalEmbeddingsController', captureException(error), error)
        }
    }

    public async load(repoUri: vscode.Uri | undefined): Promise<boolean> {
        if (!this.endpointIsDotcom) {
            // Local embeddings only supported for dotcom
            return false
        }
        const repoPath = repoUri?.fsPath
        if (!repoPath) {
            // There's no path to search
            return false
        }
        const cachedState = this.repoState.get(repoPath)
        if (cachedState && !cachedState.hasIndex) {
            // We already failed to loading this, so use that result
            return false
        }
        if (!this.serviceStarted) {
            // Try starting the service but reply that there are no local
            // embeddings this time.
            void (async () => {
                try {
                    await this.getService()
                } catch (error) {
                    logDebug('LocalEmbeddingsController', 'load', captureException(error), JSON.stringify(error))
                }
            })()
            return false
        }
        return this.eagerlyLoad(repoPath)
    }

    private async eagerlyLoad(repoPath: string): Promise<boolean> {
        try {
            const hasIndex = !!(await (await this.getService()).request('embeddings/load', repoPath))
            this.repoState.set(repoPath, {
                hasIndex,
                indexable: true,
                isGit: true,
            })
            this.lastRepo = {
                path: repoPath,
                loadResult: hasIndex,
            }
        } catch (error: any) {
            logDebug('LocalEmbeddingsController', 'load', captureException(error), JSON.stringify(error))

            const noRemoteErrorMessage = "repository does not have a default fetch URL, so can't be named for an index"
            const noRemote = error.message === noRemoteErrorMessage

            const notAGitRepositoryErrorMessage = /does not appear to be a git repository/
            const notGit = notAGitRepositoryErrorMessage.test(error.message)

            this.repoState.set(repoPath, {
                hasIndex: false,
                indexable: !(notGit || noRemote),
                isGit: !notGit,
            })

            // TODO: Log telemetry error messages to prioritize supporting
            // repos without remotes, other SCCS, etc.

            this.lastRepo = { path: repoPath, loadResult: false }
        }
        this.statusEmitter.fire(this)
        return this.lastRepo.loadResult
    }

    public async query(query: string): Promise<QueryResultSet> {
        if (!this.endpointIsDotcom) {
            return { results: [] }
        }
        return (await this.getService()).request('embeddings/query', query)
    }

    // LocalEmbeddingsFetcher
    public async getContext(query: string, _numResults: number): Promise<EmbeddingsSearchResult[]> {
        try {
            const results = (await this.query(query)).results
            logDebug('LocalEmbeddingsController', `returning ${results.length} results`)
            return results
        } catch (error) {
            logDebug('LocalEmbeddingsController', captureException(error), error)
            return []
        }
    }
}
