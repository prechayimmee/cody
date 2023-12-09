import * as React from 'react'

import { VSCodeButton, VSCodeCheckbox } from '@vscode/webview-ui-toolkit/react'
import classNames from 'classnames'

import {
    ContextGroup,
    ContextProvider,
    EnhancedContextContextT,
    LocalEmbeddingsProvider,
} from '@sourcegraph/cody-shared/src/codebase-context/context-status'

import { PopupFrame } from '../Popups/Popup'

import popupStyles from '../Popups/Popup.module.css'
import styles from './EnhancedContextSettings.module.css'

interface EnhancedContextSettingsProps {
    isOpen: boolean
    setOpen: (open: boolean) => void
}

export function defaultEnhancedContextContext(): EnhancedContextContextT {
    return {
        groups: [],
    }
}

export const EnhancedContextContext: React.Context<EnhancedContextContextT> = React.createContext(
    defaultEnhancedContextContext()
)

export const EnhancedContextEnabled: React.Context<boolean> = React.createContext(true)

export const EnhancedContextEventHandlers: React.Context<EnhancedContextEventHandlersT> = React.createContext({
    onConsentToEmbeddings: (_): void => {},
    onEnabledChange: (_): void => {},
})

export interface EnhancedContextEventHandlersT {
    onConsentToEmbeddings: (provider: LocalEmbeddingsProvider) => void
    onEnabledChange: (enabled: boolean) => void
}

export function useEnhancedContextContext(): EnhancedContextContextT {
    return React.useContext(EnhancedContextContext)
}

export function useEnhancedContextEnabled(): boolean {
    return React.useContext(EnhancedContextEnabled)
}

export function useEnhancedContextEventHandlers(): EnhancedContextEventHandlersT {
    return React.useContext(EnhancedContextEventHandlers)
}

const ContextGroupComponent: React.FunctionComponent<{ group: ContextGroup; allGroups: ContextGroup[] }> = ({
    group,
    allGroups,
}): React.ReactNode => {
    // if there's a single group, we want the group name's basename
    let groupName
    if (allGroups.length === 1) {
        const matches = group.name.match(/.+[/\\](.+?)$/)
        groupName = matches ? matches[1] : group.name
    } else {
        groupName = group.name
    }

    return (
        <>
            <dt title={group.name} className={styles.lineBreakAll}>
                <i className="codicon codicon-folder" /> {groupName}
            </dt>
            <dd>
                <ol className={styles.providersList}>
                    {group.providers.map(provider => (
                        <li key={provider.kind} className={styles.providerItem}>
                            <ContextProviderComponent provider={provider} />
                        </li>
                    ))}
                </ol>
            </dd>
        </>
    )
}

function labelFor(kind: string): string {
    // All our context providers are single words; just convert them to title
    // case
    return kind[0].toUpperCase() + kind.slice(1)
}

const EmbeddingsConsentComponent: React.FunctionComponent<{ provider: LocalEmbeddingsProvider }> = ({
    provider,
}): React.ReactNode => {
    const events = useEnhancedContextEventHandlers()
    const onClick = (): void => {
        events.onConsentToEmbeddings(provider)
    }
    return (
        <div>
            <p className={styles.providerExplanatoryText}>
                The repository&apos;s contents will be uploaded to OpenAI&apos;s Embeddings API and then stored locally.
                {/* To exclude files, set up a <a href="about:blank#TODO">Cody ignore file.</a> */}
            </p>
            <p>
                <VSCodeButton onClick={onClick}>Enable Embeddings</VSCodeButton>
            </p>
        </div>
    )
}

function contextProviderState(provider: ContextProvider): React.ReactNode {
    switch (provider.state) {
        case 'indeterminate':
            return <></>
        case 'ready':
            if (provider.kind === 'embeddings' && provider.type === 'remote') {
                return (
                    <p className={classNames(styles.providerExplanatoryText, styles.lineBreakAll)}>
                        Inherited {provider.remoteName}
                    </p>
                )
            }
            return <span className={styles.providerInlineState}>&mdash; Indexed</span>
        case 'indexing':
            return <span className={styles.providerInlineState}>&mdash; Indexing&hellip;</span>
        case 'unconsented':
            return <EmbeddingsConsentComponent provider={provider} />
        case 'no-match':
            return provider.kind === 'embeddings' && provider.type === 'remote' ? (
                <p className={styles.providerExplanatoryText}>
                    {/* No repository matching {provider.remoteName} on <a href="about:blank#TODO">{provider.origin}</a> */}
                    No repository matching {provider.remoteName} on {provider.origin}
                </p>
            ) : (
                <p className={styles.providerExplanatoryText}>Hello, world</p>
            )
        default:
            return ''
    }
}

const ContextProviderComponent: React.FunctionComponent<{ provider: ContextProvider }> = ({ provider }) => {
    let stateIcon
    switch (provider.state) {
        case 'indeterminate':
        case 'indexing':
            stateIcon = <i className="codicon codicon-loading codicon-modifier-spin" />
            break
        case 'unconsented':
            stateIcon = <i className="codicon codicon-circle-outline" />
            break
        case 'ready':
            stateIcon = <i className="codicon codicon-database" />
            break
        case 'no-match':
            stateIcon = <i className="codicon codicon-circle-slash" />
            break
        default:
            stateIcon = '?'
            break
    }
    return (
        <>
            <span className={styles.providerIconAndName}>
                {stateIcon} <span className={styles.providerLabel}>{labelFor(provider.kind)}</span>
            </span>{' '}
            {contextProviderState(provider)}
        </>
    )
}

export const EnhancedContextSettings: React.FunctionComponent<EnhancedContextSettingsProps> = ({
    isOpen,
    setOpen,
}): React.ReactNode => {
    const events = useEnhancedContextEventHandlers()
    const context = useEnhancedContextContext()
    const [enabled, setEnabled] = React.useState<boolean>(useEnhancedContextEnabled())
    const enabledChanged = React.useCallback(
        (event: any): void => {
            const shouldEnable = !!event.target?.checked
            if (enabled !== shouldEnable) {
                events.onEnabledChange(shouldEnable)
                setEnabled(shouldEnable)
            }
        },
        [events, enabled]
    )

    const hasOpenedBeforeKey = 'enhanced-context-settings.has-opened-before'
    const hasOpenedBefore = localStorage.getItem(hasOpenedBeforeKey) === 'true'
    if (isOpen && !hasOpenedBefore) {
        localStorage.setItem(hasOpenedBeforeKey, 'true')
    }

    return (
        <div className={classNames(popupStyles.popupHost)}>
            <PopupFrame
                isOpen={isOpen}
                onDismiss={() => setOpen(false)}
                classNames={[popupStyles.popupTrail, styles.enhancedContextSettingsPopup]}
            >
                <div className={styles.enhancedContextInnerContainer}>
                    <div>
                        <VSCodeCheckbox onChange={enabledChanged} checked={enabled} id="enhanced-context-checkbox" />
                    </div>
                    <div>
                        <label htmlFor="enhanced-context-checkbox">
                            <h1>Enhanced Context ✨</h1>
                        </label>
                        <p>
                            Include additional code context with your message.{' '}
                            {/* <a href="about:blank#TODO">Learn more</a> */}
                        </p>
                        <dl className={styles.foldersList}>
                            {context.groups.map(group => (
                                <ContextGroupComponent key={group.name} group={group} allGroups={context.groups} />
                            ))}
                        </dl>
                    </div>
                </div>
            </PopupFrame>
            <VSCodeButton
                className={classNames(popupStyles.popupHost, styles.settingsBtn, enabled && styles.settingsBtnActive)}
                appearance="icon"
                type="button"
                onClick={() => setOpen(!isOpen)}
                title="Configure Enhanced Context"
            >
                <i className="codicon codicon-sparkle" />
                {isOpen || hasOpenedBefore ? null : <div className={styles.glowyDot} />}
            </VSCodeButton>
        </div>
    )
}
