export const DOTCOM_URL = new URL(process.env.TESTING_DOTCOM_URL || 'https://sourcegraph.com')
export const INTERNAL_S2_URL = new URL('https://sourcegraph.sourcegraph.com/')
export const LOCAL_APP_URL = new URL('http://localhost:3080')

// 🚨 SECURITY: This is used as a check for logging chatTranscript for dotcom users only, be extremely careful if modifying this function
export function isDotCom(url: string): boolean {
    try {
        return new URL(url).origin === DOTCOM_URL.origin
    } catch {
        return false
    }
}

export function isInternalUser(url: string): boolean {
    try {
        return new URL(url).origin === INTERNAL_S2_URL.origin
    } catch {
        return false
    }
}
