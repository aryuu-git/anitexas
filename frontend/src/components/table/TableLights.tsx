/**
 * 灯光：顶部聚光 + 四角暗角，模拟牌桌顶灯；纯装饰，不接收指针事件。
 * reducer-motion 下静态显示（本身无动画）。
 */
export function TableLights() {
  return (
    <>
      <div
        className="pointer-events-none absolute inset-x-[3.5%] inset-y-[8%] rounded-[50%] bg-spotlight mix-blend-screen"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-x-[0.5%] inset-y-[2%] rounded-[50%] bg-vignette"
        aria-hidden="true"
      />
    </>
  )
}
