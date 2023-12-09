import { mkdir, mkdtempSync, rmSync, writeFile } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'

import { test as base, expect, Frame, Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import * as uuid from 'uuid'

import { resetLoggedEvents, run, sendTestInfo } from '../fixtures/mock-server'

import { installVsCode } from './install-deps'

export interface WorkspaceDirectory {
    workspaceDirectory: string
}

export interface WorkspaceSettings {
    [key: string]: string | boolean | number
}

export interface ExtraWorkspaceSettings {
    extraWorkspaceSettings: WorkspaceSettings
}

export interface DotcomUrlOverride {
    dotcomUrl: string | undefined
}

export const test = base
    .extend<WorkspaceDirectory>({
        // Playwright needs empty pattern to specify "no dependencies".
        // eslint-disable-next-line no-empty-pattern
        workspaceDirectory: async ({}, use) => {
            const vscodeRoot = path.resolve(__dirname, '..', '..')
            const workspaceDirectory = path.join(vscodeRoot, 'test', 'fixtures', 'workspace')
            await use(workspaceDirectory)
        },
    })
    .extend<ExtraWorkspaceSettings>({
        extraWorkspaceSettings: {},
    })
    .extend<DotcomUrlOverride>({
        dotcomUrl: undefined,
    })
    .extend<{}>({
        page: async ({ page: _page, workspaceDirectory, extraWorkspaceSettings, dotcomUrl }, use, testInfo) => {
            void _page

            const vscodeRoot = path.resolve(__dirname, '..', '..')

            const vscodeExecutablePath = await installVsCode()
            const extensionDevelopmentPath = vscodeRoot

            const userDataDirectory = mkdtempSync(path.join(tmpdir(), 'cody-vsce'))
            const extensionsDirectory = mkdtempSync(path.join(tmpdir(), 'cody-vsce'))
            const videoDirectory = path.join(vscodeRoot, '..', 'playwright', escapeToPath(testInfo.title))

            console.log(`Workspace directory: ${workspaceDirectory}`)

            await buildWorkSpaceSettings(workspaceDirectory, extraWorkspaceSettings)

            sendTestInfo(testInfo.title, testInfo.testId, uuid.v4())

            let dotcomUrlOverride: { [key: string]: string } = {}
            if (dotcomUrl) {
                dotcomUrlOverride = { TESTING_DOTCOM_URL: dotcomUrl }
            }

            // See: https://github.com/microsoft/vscode-test/blob/main/lib/runTest.ts
            const app = await electron.launch({
                executablePath: vscodeExecutablePath,
                env: {
                    ...process.env,
                    ...dotcomUrlOverride,
                    CODY_TESTING: 'true',
                },
                args: [
                    // https://github.com/microsoft/vscode/issues/84238
                    '--no-sandbox',
                    // https://github.com/microsoft/vscode-test/issues/120
                    '--disable-updates',
                    '--skip-welcome',
                    '--skip-release-notes',
                    '--disable-workspace-trust',
                    '--extensionDevelopmentPath=' + extensionDevelopmentPath,
                    `--user-data-dir=${userDataDirectory}`,
                    `--extensions-dir=${extensionsDirectory}`,
                    workspaceDirectory,
                ],
                recordVideo: {
                    dir: videoDirectory,
                },
            })

            await waitUntil(() => app.windows().length > 0)

            const page = await app.firstWindow()

            // Bring the cody sidebar to the foreground
            await page.click('[aria-label="Cody"]')
            // Ensure that we remove the hover from the activity icon
            await page.getByRole('heading', { name: 'Cody: Chat' }).hover()
            // Wait for Cody to become activated
            // TODO(philipp-spiess): Figure out which playwright matcher we can use that works for
            // the signed-in and signed-out cases
            await new Promise(resolve => setTimeout(resolve, 500))

            await run(async () => {
                // Ensure we're signed out.
                if (await page.isVisible('[aria-label="User Settings"]')) {
                    await signOut(page)
                }

                resetLoggedEvents()
                await use(page)
            })

            await app.close()

            // Delete the recorded video if the test passes
            if (testInfo.status === 'passed') {
                rmSync(videoDirectory, { recursive: true })
            }

            rmSync(userDataDirectory, { recursive: true })
            rmSync(extensionsDirectory, { recursive: true })
        },
    })
    .extend<{ sidebar: Frame }>({
        sidebar: async ({ page }, use) => {
            const sidebar = await getCodySidebar(page)
            await use(sidebar)
        },
    })

export async function getCodySidebar(page: Page): Promise<Frame> {
    async function findCodySidebarFrame(): Promise<null | Frame> {
        for (const frame of page.frames()) {
            try {
                const title = await frame.title()
                if (title === 'Cody') {
                    return frame
                }
            } catch (error: any) {
                // Skip over frames that were detached in the meantime.
                if (error.message.indexOf('Frame was detached') === -1) {
                    throw error
                }
            }
        }
        return null
    }
    await waitUntil(async () => (await findCodySidebarFrame()) !== null)
    return (await findCodySidebarFrame()) || page.mainFrame()
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
    let delay = 10
    while (!(await predicate())) {
        await new Promise(resolve => setTimeout(resolve, delay))
        delay <<= 1
    }
}

function escapeToPath(text: string): string {
    return text.replaceAll(/\W/g, '_')
}

// Build a workspace settings file that enables the experimental inline mode
export async function buildWorkSpaceSettings(
    workspaceDirectory: string,
    extraSettings: WorkspaceSettings
): Promise<void> {
    console.log(
        `Building workspace settings for ${workspaceDirectory} with extra settings ${JSON.stringify(extraSettings)}`
    )
    const settings = {
        'cody.serverEndpoint': 'http://localhost:49300',
        'cody.commandCodeLenses': true,
        'cody.editorTitleCommandIcon': true,
        ...extraSettings,
    }
    // create a temporary directory with settings.json and add to the workspaceDirectory
    const workspaceSettingsPath = path.join(workspaceDirectory, '.vscode', 'settings.json')
    const workspaceSettingsDirectory = path.join(workspaceDirectory, '.vscode')
    await new Promise((resolve, reject) => {
        mkdir(workspaceSettingsDirectory, { recursive: true }, err => (err ? reject(err) : resolve(undefined)))
    })
    await new Promise<void>((resolve, reject) => {
        writeFile(workspaceSettingsPath, JSON.stringify(settings), error => {
            if (error) {
                reject(error)
            } else {
                resolve()
            }
        })
    })
}

export async function signOut(page: Page): Promise<void> {
    // TODO(sqs): could simplify this further with a cody.auth.signoutAll command
    await page.keyboard.press('F1')
    await page.getByRole('combobox', { name: 'input' }).fill('>cody sign out')
    await page.keyboard.press('Enter')
}

export async function submitChat(sidebar: Frame, text: string): Promise<void> {
    await sidebar.getByRole('textbox', { name: 'Chat message' }).fill(text)
    await sidebar.getByTitle('Send Message').click()
}

/**
 * Verifies that loggedEvents contain all of expectedEvents (in any order).
 */
export async function assertEvents(loggedEvents: string[], expectedEvents: string[]): Promise<void> {
    await expect.poll(() => loggedEvents).toEqual(expect.arrayContaining(expectedEvents))
}
