/**
 * 下注线：毡面内圈的一条细椭圆虚线——所有「注堆」的落点都在这条线上。
 * 纯装饰层，不接收指针事件。
 */
export function TableBettingLine() {
  return (
    <div
      className="pointer-events-none absolute inset-x-[9%] inset-y-[15%] rounded-[50%] border border-dashed border-gold-foil/20"
      data-testid="betting-line"
      aria-hidden="true"
    />
  )
}
