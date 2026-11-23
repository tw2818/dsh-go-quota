// 提供商注册表。
//
// 加一家提供商：写一个 lib/providers/<id>.js，实现 fetch / build / error，
// 然后在这里登记一行。界面部分不认识具体是谁，只按这个数组跑一圈。
//
// 想让用户自己加渠道，把这个数组换成「读配置生成」的地方即可，
// 每个 provider 文件的形状不用变。

import minimax from './minimax.js'
import opencode from './opencode.js'

export const PROVIDERS = [minimax, opencode]
