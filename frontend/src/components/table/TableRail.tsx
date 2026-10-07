/**
 * 桌沿（桌沿 v2）：赛道型高起护边——外圈投影 + 上缘金粉斜面高光 + 内缘暗部。
 * 与 TableFelt 叠加使用：本组件画外盘，毡面盖住中间，留下的环即桌沿。
 */
export function TableRail() {
  return (
    <>
      {/* 外盘（桌沿本体） */}
      <div
        className="absolute inset-x-[0.5%] inset-y-[2%] rounded-[50%] bg-rail shadow-rail"
        aria-hidden="true"
      />
      {/* 上缘斜面高光（细环） */}
      <div
        className="absolute inset-x-[1.3%] inset-y-[3.4%] rounded-[50%] bg-rail-edge opacity-45"
        aria-hidden="true"
      />
      {/* 桌沿内缘金线 */}
      <div
        className="absolute inset-x-[3.1%] inset-y-[7.2%] rounded-[50%] border border-gold-foil/25"
        aria-hidden="true"
      />
    </>
  )
}
