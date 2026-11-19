import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import { gatewayEventCompletedFileDiff } from '@/lib/gateway-events'
import { $previewTabUrl, $previewTarget } from '@/store/preview'
import type { RpcEvent } from '@/types/alice'

type EventHandler = (event: RpcEvent) => void

interface PreviewRoutingOptions {
  activeSessionIdRef: MutableRefObject<string | null>
  baseHandleGatewayEvent: EventHandler
}

/**
 * Desktop gateway-event routing.
 *
 * The preview rail is gone (Fase 3): previews open as browser tabs, so there is
 * no pane to restore, restart or reload. What remains is the one rule that still
 * needs the gateway: when the agent rewrites a file that a *web* preview is
 * serving (a runnable artifact), reload that browser tab so the user sees the
 * new version.
 */
export function usePreviewRouting({ activeSessionIdRef, baseHandleGatewayEvent }: PreviewRoutingOptions) {
  const handleDesktopGatewayEvent = useCallback<EventHandler>(
    event => {
      baseHandleGatewayEvent(event)

      if (event.session_id && event.session_id !== activeSessionIdRef.current) {
        return
      }

      const target = $previewTarget.get()

      if (target?.kind === 'url' && $previewTabUrl.get() && gatewayEventCompletedFileDiff(event)) {
        // Reload through the browser service instead of a rail-owned iframe.
        const tabUrl = $previewTabUrl.get()

        if (tabUrl && window.aliceDesktop?.browser) {
          void window.aliceDesktop.browser.navigate(tabUrl)
        }
      }
    },
    [activeSessionIdRef, baseHandleGatewayEvent]
  )

  return { handleDesktopGatewayEvent }
}
