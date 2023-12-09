import * as child_process from 'child_process'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { expect, FrameLocator, Page } from '@playwright/test'

import { SERVER_URL } from '../fixtures/mock-server'

import { sidebarSignin } from './common'
import * as helpers from './helpers'

async function withTempDir<T>(f: (dir: string) => Promise<T>): Promise<T> {
    // Create the temporary directory
    const dir = await fs.mkdtemp(await fs.realpath(os.tmpdir() + path.sep))
    try {
        return await f(dir)
    } finally {
        // Remove the temporary directory
        await fs.rm(dir, { recursive: true, force: true })
    }
}

function spawn(...args: Parameters<typeof child_process.spawn>): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = child_process.spawn(...args)
        child.once('close', (code, signal) => {
            if (code || signal) {
                reject(new Error(`child exited with code ${code}/signal ${signal}`))
            } else {
                resolve()
            }
        })
    })
}

async function openFile(page: Page, filename: string): Promise<void> {
    // Open a file from the file picker
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('P')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')
    await page.keyboard.type(`${filename}\n`)
}

async function newChat(page: Page): Promise<FrameLocator> {
    await page.getByRole('button', { name: 'New Chat' }).click()
    return page.frameLocator('iframe.webview').last().frameLocator('iframe')
}

// Reconfigured test for local embeddings:
// - treats http://localhost:49000 as dotcom
// - uses a temporary workspace that's a git repository
// - uses a temporary directory for local embeddings indexes
// - uses the stub/stub embeddings model
const test = helpers.test
    .extend<helpers.DotcomUrlOverride>({
        dotcomUrl: SERVER_URL,
    })
    .extend<helpers.WorkspaceDirectory>({
        // Playwright needs empty pattern to specify "no dependencies".
        // eslint-disable-next-line no-empty-pattern
        workspaceDirectory: async ({}, use) => {
            await withTempDir(async dir => {
                // Initialize a git repository there
                await spawn('git', ['init'], { cwd: dir })
                await spawn('git', ['config', 'user.name', 'Test User'], { cwd: dir })
                await spawn('git', ['config', 'user.email', 'test@example.host'], { cwd: dir })

                // Commit some content to the git repository.
                await Promise.all([
                    fs.writeFile(path.join(dir, 'README.md'), 'Prints an classic greeting'),
                    fs.writeFile(path.join(dir, 'main.c'), '#include <stdio.h> main() { printf("Hello, world.\\n"); }'),
                ])
                await spawn('git', ['add', 'README.md', 'main.c'], { cwd: dir })
                await spawn('git', ['commit', '-m', 'Initial commit'], { cwd: dir })

                await use(dir)
            })
        },
    })
    .extend<helpers.ExtraWorkspaceSettings>({
        // Playwright needs empty pattern to specify "no dependencies".
        // eslint-disable-next-line no-empty-pattern
        extraWorkspaceSettings: async ({}, use) => {
            await withTempDir(async dir =>
                use({
                    'cody.testing.localEmbeddings.model': 'stub/stub',
                    'cody.testing.localEmbeddings.indexLibraryPath': dir,
                })
            )
        },
    })

test.extend<helpers.WorkspaceDirectory>({
    // Playwright needs empty pattern to specify "no dependencies".
    // eslint-disable-next-line no-empty-pattern
    workspaceDirectory: async ({}, use) => {
        await withTempDir(async dir => {
            // Write some content to the filesystem. But this is not a git repository.
            await Promise.all([
                fs.writeFile(path.join(dir, 'README.md'), 'Prints an classic greeting'),
                fs.writeFile(path.join(dir, 'main.c'), '#include <stdio.h> main() { printf("Hello, world.\\n"); }'),
            ])
            await use(dir)
        })
    },
})('non-git repositories should not advertise embeddings', async ({ page, sidebar }) => {
    await openFile(page, 'main.c')
    await sidebarSignin(page, sidebar)
    const chatFrame = await newChat(page)
    const enhancedContextButton = chatFrame.getByTitle('Configure Enhanced Context')
    await enhancedContextButton.click()

    // Embeddings is visible at first as cody-engine starts...
    await expect(chatFrame.getByText('Embeddings')).toBeVisible()
    // ...and disappears when the engine works out this is not a git repo.
    await expect(chatFrame.getByText('Embeddings')).not.toBeVisible()
})

test('git repositories without a remote should show the "no match" state', async ({ page, sidebar }) => {
    await openFile(page, 'main.c')
    await sidebarSignin(page, sidebar)
    const chatFrame = await newChat(page)
    const enhancedContextButton = chatFrame.getByTitle('Configure Enhanced Context')
    await enhancedContextButton.click()
    await expect(chatFrame.locator('.codicon-circle-slash')).toBeVisible()
})

test.extend<helpers.WorkspaceDirectory>({
    workspaceDirectory: async ({ workspaceDirectory }, use) => {
        // Add a remote to the git repo so that it can be indexed.
        await spawn('git', ['remote', 'add', 'origin', 'git@host.example:user/repo.git'], { cwd: workspaceDirectory })
        await use(workspaceDirectory)
    },
})('should be able to index, then search, a git repository', async ({ page, sidebar }) => {
    await openFile(page, 'main.c')
    await sidebarSignin(page, sidebar)
    const chatFrame = await newChat(page)
    const enhancedContextButton = chatFrame.getByTitle('Configure Enhanced Context')
    await enhancedContextButton.click()

    const enableEmbeddingsButton = chatFrame.getByText('Enable Embeddings')
    // This may take a while, we download and start cody-engine
    await expect(enableEmbeddingsButton).toBeVisible({ timeout: 300000 })
    await enableEmbeddingsButton.click()

    await expect(chatFrame.getByText('Indexed')).toBeVisible({ timeout: 30000 })

    // Search the embeddings. This test uses the "stub" embedding model, which
    // is deterministic, but the searches are not semantic.
    await chatFrame.locator('textarea').type('hello world\n')
    await expect(chatFrame.getByText(/✨ Context: \d+ lines from 2 files/)).toBeVisible({ timeout: 10000 })
})
