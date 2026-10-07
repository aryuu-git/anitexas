import { defineConfig } from 'vitest/config'

// 独立测试配置：与 vite.config.ts 解耦（后者含 dev 代理与产物目录，与测试无关）。
// 默认 node 环境跑纯逻辑；需要 DOM 的组件测试在用例内以
// `// @vitest-environment happy-dom` 声明（对齐 karuta 惯例）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
