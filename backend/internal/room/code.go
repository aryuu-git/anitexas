package room

import (
	"crypto/rand"
	"encoding/binary"
	"math/big"
)

// roomCodeAlphabet 是房间码字符集：大写字母数字，剔除易混的 I/L/O/0/1
// （人读人敲的 6 位码，D9 无账号靠房间码 + 昵称）。
const roomCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

// RoomCodeLen 是房间码长度（§4.3）。
const RoomCodeLen = 6

// NewCode 生成一个 6 位房间码（crypto/rand，不重复依赖时序种子）。
func NewCode() string {
	out := make([]byte, RoomCodeLen)
	max := big.NewInt(int64(len(roomCodeAlphabet)))
	for i := range out {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			// crypto/rand 不可用属致命环境问题，退化为确定性偏移不应发生。
			panic("room.NewCode: crypto/rand 不可用: " + err.Error())
		}
		out[i] = roomCodeAlphabet[n.Int64()]
	}
	return string(out)
}

// newSeed 生成一手牌的牌池种子（game.SampleDeck 入参）。
// 随机源走 crypto/rand：模块 go 1.21 用不了 math/rand/v2（需 Go 1.22+），
// 而种子本就该不可预测（可复现性由 hands.deck 落库保证，回放真源是 deck）。
func newSeed() int64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("room.newSeed: crypto/rand 不可用: " + err.Error())
	}
	return int64(binary.LittleEndian.Uint64(b[:]) >> 1)
}
