declare module '@assistant-ui/core' {
  import type { ComponentProps, JSX } from 'react'
  export interface Unstable_TriggerAdapter { }
  export interface Unstable_TriggerItem { }
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  export interface ToolFallback { }
}
declare module '@assistant-ui/react' {
  export function ComposerPrimitive(props: any): JSX.Element
  export function useAui<T>(selector: (state: any) => T): T
  export function useAuiState<T>(selector: (state: any) => T): T
  export function useComposerRuntime(): any
}
