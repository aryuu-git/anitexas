/** @type {import('tailwindcss').Config} */
// 樱墨设计系统（A5.1）：token 全部移植自 docs/rules.html <style>（规则书 v1.0）。
// 颜色一律引用 index.css 的 RGB 三元组变量（rgb(var(--color-x) / <alpha>)），
// 组件代码禁止裸色值；色板语义：
//   ink 墨底 / gold 樱粉 / gold-foil 金粉 / surface 面板 / muted 淡樱文字
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // ===== 墨底族 =====
        ink: {
          DEFAULT: 'rgb(var(--color-ink) / <alpha-value>)',
          deep: 'rgb(var(--color-ink-deep) / <alpha-value>)',
        },
        // ===== 樱粉族（主强调色，rules.html 的 --gold 语义）=====
        gold: {
          DEFAULT: 'rgb(var(--color-gold) / <alpha-value>)',
          light: 'rgb(var(--color-gold-light) / <alpha-value>)',
          dark: 'rgb(var(--color-gold-dark) / <alpha-value>)',
        },
        // ===== 金粉族（成组描金、仪式性高亮）=====
        'gold-foil': 'rgb(var(--color-gold-foil) / <alpha-value>)',
        // ===== 面板族 =====
        surface: {
          DEFAULT: 'rgb(var(--color-surface) / <alpha-value>)',
          elevated: 'rgb(var(--color-surface-elevated) / <alpha-value>)',
        },
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
        'body-text': 'rgb(var(--color-body-text) / <alpha-value>)',
        danger: 'rgb(var(--color-danger) / <alpha-value>)',
        success: 'rgb(var(--color-success) / <alpha-value>)',
      },
      fontFamily: {
        // 规则书同款字族链：思源宋体标题 + 系统无衬线正文
        serif: ['"Noto Serif SC"', '"Source Han Serif SC"', '"Songti SC"', 'serif'],
        sans: ['system-ui', '"Segoe UI"', '"Microsoft YaHei"', 'sans-serif'],
      },
      fontSize: {
        // 字阶 token（rules.html：hero 48–72 / h2 30 / 牌型名 23 / 牌名 17 /
        // 评分大数 36 / 正文 14.5–16.5 / kicker 11.5 / 微标 10.5）
        display: ['clamp(3rem, 7vw, 4.5rem)', { lineHeight: '1.1', fontWeight: '700', letterSpacing: '0.1em' }],
        'sec-title': ['1.875rem', { lineHeight: '1.3', fontWeight: '700', letterSpacing: '0.1em' }],
        'tier-name': ['1.4375rem', { lineHeight: '1.35', fontWeight: '700', letterSpacing: '0.08em' }],
        score: ['2.25rem', { lineHeight: '1', fontWeight: '700' }],
        'card-name': ['1.0625rem', { lineHeight: '1.5' }],
        'body-lg': ['1.03125rem', { lineHeight: '1.75' }],
        body: ['0.90625rem', { lineHeight: '1.75' }],
        caption: ['0.78125rem', { lineHeight: '1.6' }],
        tiny: ['0.71875rem', { lineHeight: '1.5' }],
        micro: ['0.65625rem', { lineHeight: '1.4', letterSpacing: '0.12em' }],
        kicker: ['0.75rem', { lineHeight: '1.5', letterSpacing: '0.5em', fontWeight: '500' }],
      },
      borderRadius: {
        // 圆角 token（rules.html：面板/牌面 16 / mini 12 / 牌 11 / code 8）
        panel: '16px',
        card: '14px',
        tile: '11px',
        chip: '999px',
        micro: '8px',
      },
      boxShadow: {
        // 阴影 token（rules.html；「克制光效」——金晕只做描金与当前行动者）
        panel: '0 2px 8px rgb(0 0 0 / 0.25)',
        lift: '0 4px 16px rgb(0 0 0 / 0.3)',
        card: '0 10px 28px rgb(0 0 0 / 0.35)',
        fan: '0 10px 26px rgb(0 0 0 / 0.35)',
        'card-glow': '0 0 14px rgb(var(--color-gold-foil) / 0.2)',
        'mcard': '0 0 10px rgb(var(--color-gold-foil) / 0.15)',
        'foil': '0 0 16px rgb(var(--color-gold-foil) / 0.15)',
        'foil-strong': '0 0 22px rgb(var(--color-gold-foil) / 0.18)',
        glow: '0 0 15px rgb(var(--color-gold) / 0.25)',
        'turn': '0 0 18px rgb(var(--color-gold-foil) / 0.35), 0 0 4px rgb(var(--color-gold) / 0.3)',
        // ===== 牌桌 v2 阴影 =====
        // 桌沿：外投影 + 上缘高光 + 内缘暗部（立体护边）
        'rail': '0 22px 48px rgb(0 0 0 / 0.55), inset 0 2px 0 rgb(255 255 255 / 0.12), inset 0 -8px 18px rgb(0 0 0 / 0.65)',
        // 毡面内凹（内阴影）
        'felt-inset': 'inset 0 0 70px rgb(0 0 0 / 0.55), inset 0 3px 8px rgb(0 0 0 / 0.5)',
        // 卡牌抬升 + 顶部微高光
        'card-lift': '0 12px 26px rgb(0 0 0 / 0.5), inset 0 1px 0 rgb(255 255 255 / 0.06)',
        // 头像徽章
        'avatar': '0 6px 16px rgb(0 0 0 / 0.5), inset 0 1px 0 rgb(255 255 255 / 0.14)',
      },
      backgroundImage: {
        // 页面墨底（rules.html body 同款三重渐变，fixed 附着在 index.css 处理）
        'ink-page':
          'radial-gradient(1100px 460px at 88% -8%, rgb(var(--color-gold-foil) / 0.10), transparent 60%),' +
          'radial-gradient(820px 420px at -8% 10%, rgb(var(--color-gold) / 0.07), transparent 55%),' +
          'linear-gradient(180deg, rgb(var(--color-ink)) 0%, rgb(var(--color-ink-deep)) 100%)',
        // 大牌封面区（card-face .art）
        'cover-lg':
          'radial-gradient(240px 130px at 72% 18%, rgb(var(--color-gold) / 0.3), transparent 70%),' +
          'repeating-linear-gradient(-45deg, rgb(var(--color-gold-foil) / 0.07) 0 10px, transparent 10px 20px),' +
          'linear-gradient(135deg, rgb(var(--color-gold) / 0.18), rgb(var(--color-gold-foil) / 0.12))',
        // 迷你牌封面区（mcover）
        'cover-sm':
          'radial-gradient(90px 50px at 75% 20%, rgb(var(--color-gold) / 0.3), transparent 70%),' +
          'repeating-linear-gradient(-45deg, rgb(var(--color-gold-foil) / 0.08) 0 8px, transparent 8px 16px),' +
          'linear-gradient(135deg, rgb(var(--color-gold) / 0.16), rgb(var(--color-gold-foil) / 0.1))',
        // 牌身/牌背（.fc 扇面与 card-face 同源）
        'card-body': 'linear-gradient(165deg, rgb(var(--color-surface-elevated)), rgb(var(--color-surface)) 55%, rgb(var(--color-ink-deep)))',
        'card-body-soft':
          'linear-gradient(165deg, rgb(var(--color-surface-elevated) / 0.85), rgb(var(--color-surface) / 0.72) 55%, rgb(var(--color-ink-deep) / 0.8))',
        // 面板族（.panel / .tier / .toc）
        'panel': 'linear-gradient(180deg, rgb(var(--color-surface) / 0.62), rgb(var(--color-ink-deep) / 0.55))',
        'panel-soft': 'linear-gradient(180deg, rgb(var(--color-surface) / 0.55), rgb(var(--color-ink-deep) / 0.5))',
        'panel-legend': 'linear-gradient(180deg, rgb(var(--color-gold-foil) / 0.10), rgb(var(--color-surface) / 0.5) 45%, rgb(var(--color-ink-deep) / 0.55))',
        // 描金顶线（.panel.accent::before）与 hero 金线、全桌特效光斑
        'accent-line': 'linear-gradient(90deg, transparent, rgb(var(--color-gold-foil) / 0.5), transparent)',
        'gold-fade': 'linear-gradient(90deg, rgb(var(--color-gold-foil) / 0.8), transparent)',
        'glow-radial': 'radial-gradient(circle, rgb(var(--color-gold-foil) / 0.35), transparent 70%)',
        // 主按钮樱粉渐变
        'gold-gradient': 'linear-gradient(135deg, rgb(var(--color-gold)) 0%, rgb(var(--color-gold-light)) 50%, rgb(var(--color-gold-dark)) 100%)',
        // 德州桌布（椭圆）：樱墨暗底 + 中央微亮；桌沿金粉细线由 border + felt-rail 叠。
        'felt':
          'radial-gradient(85% 70% at 50% 42%, rgb(var(--color-surface) / 0.55), rgb(var(--color-ink-deep) / 0.9) 72%)',
        'felt-rail':
          'radial-gradient(92% 78% at 50% 42%, transparent 60%, rgb(var(--color-gold-foil) / 0.12) 61%, transparent 69%)',
        // ===== 牌桌 v2（赛道桌 + 高起桌沿）=====
        // 桌沿：金粉斜面高光 -> 暗部（立体护边）
        'rail': 'linear-gradient(180deg, rgb(var(--color-gold-foil) / 0.42), rgb(var(--color-ink-deep)) 55%, rgb(0 0 0 / 0.72))',
        'rail-edge': 'linear-gradient(180deg, rgb(var(--color-gold-foil) / 0.65), rgb(var(--color-gold-foil) / 0.06))',
        // 毡面：顶亮底暗 + 中央微亮
        'felt-v2': 'radial-gradient(120% 105% at 50% 16%, rgb(var(--color-surface) / 0.72), rgb(var(--color-ink-deep)) 70%)',
        // 桌心印记：樱花徽记的柔光底
        'inlay': 'radial-gradient(circle at 50% 50%, rgb(var(--color-gold-foil) / 0.12), transparent 62%)',
        // 顶部聚光 + 四角暗角
        'spotlight': 'radial-gradient(72% 62% at 50% 24%, rgb(255 255 255 / 0.10), transparent 72%)',
        'vignette': 'radial-gradient(132% 112% at 50% 46%, transparent 52%, rgb(0 0 0 / 0.58) 100%)',
        // 牌背：樱墨斜纹 + 中心樱花光
        'card-back':
          'radial-gradient(60% 45% at 50% 34%, rgb(var(--color-gold-foil) / 0.18), transparent 70%),' +
          'repeating-linear-gradient(-45deg, rgb(var(--color-gold-foil) / 0.10) 0 6px, transparent 6px 12px),' +
          'linear-gradient(160deg, rgb(var(--color-surface-elevated)), rgb(var(--color-ink-deep)))',
        // 赢家扫光：旋转的金色扇形（配合 animate-sweep 扫过桌面）
        'sweep': 'conic-gradient(from 0deg, transparent 0deg, rgb(var(--color-gold-foil) / 0.30) 42deg, transparent 108deg)',
      },
      transitionDuration: {
        // 时长 token：fast=微交互 / base=展开动画 250ms（A5.2）/ slow=仪式性
        fast: '150ms',
        base: '250ms',
        slow: '400ms',
      },
      transitionTimingFunction: {
        // rules.html 统一缓动
        standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      zIndex: {
        seat: '10',
        overlay: '40',
        modal: '100',
      },
      maxWidth: {
        content: '1120px',
      },
      keyframes: {
        // 当前行动者金光呼吸（克制：低幅度透明度脉动）
        glowPulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        // 入场：自下浮起
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'glow-pulse': 'glowPulse 2.2s ease-in-out infinite',
        'fade-up': 'fadeUp 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both',
      },
    },
  },
  plugins: [],
}
