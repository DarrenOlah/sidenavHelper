/// <reference types="vite/client" />

declare const __APP_VERSION__: string

declare module '*.css?raw' {
  const src: string
  export default src
}

declare module '*.js?raw' {
  const src: string
  export default src
}
