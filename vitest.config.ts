import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Process CSS imports so `import sidenavCss from '…/sidenav.css?raw'`
    // returns the file contents in tests (default behavior stubs them).
    css: { include: [/.+/] },
  },
})
