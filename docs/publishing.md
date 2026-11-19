# 发布到 npm

本文写给**维护者**。使用这个包不需要读它。

```bash
npm login --auth-type=web     # 浏览器完成登录（CLI 侧不再要求本地 OTP）
npm pack --dry-run            # 看清单与体积（0.2.0：493 KB / 38 个文件）
npm version patch             # bump 版本（已发布版本不可覆盖）
npm stage publish             # 只是暂存；发布见下节「2FA 与 staged publishing」
```

发布前确认四件事：

1. `package.json` **不能有** `"private": true`；
2. `typebox` / `@earendil-works/*` 只能在 `peerDependencies`（`"*"`）里，**不能进 `dependencies`**——物理副本会绕过 pi 的模块映射（`docs/packages.md:114`）；
3. 版本号必须 bump（同版本重发会被 registry 拒绝，已发布版本删不掉，只能 `npm deprecate`）；
4. 包名可用：`curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/pi-living-memory`，`404` 才是空闲。

`keywords` 里有 `pi-package` 就会出现在 [pi.dev/packages](https://pi.dev/packages) 的 gallery。注意 **gallery 的搜索索引与包详情是两套数据源**：详情页（`https://pi.dev/packages/<包名>`）发布即可见，搜索页要等索引重建（实测 0.2.0 发布当天搜索仍是 0 结果，详情页正常）。

发布后 `pi install npm:pi-living-memory@<版本>` 在**另一台机器或临时 HOME** 验证。**本仓的开发机保持本地路径安装**，不要为了验证把 `settings.json` 里的本地路径换成 npm spec——那样之后改源码就不会生效，造成「源码改了、装的是旧行为」的错觉。

发版前的文档同步检查（这几处最容易漂移）：

另：**README 里的文档链接必须用绝对 URL**（`https://github.com/robert-zz/pi-living-memory/blob/main/docs/...`）。相对路径 `docs/x.md` 在 GitHub 上正常，但在 npm 包页面会解析成 `npmjs.com/package/pi-living-memory/docs/x.md` → 404。


```bash
grep -n '<you>' README.md                    # 占位符必须清零
grep -n 'pi-living-memory@v' README.md       # 安装示例对齐刚发的 tag
grep -n '用例 / \|cases / ' README.md        # 测试计数与 bun tests/run.ts 输出一致
```


### 2FA 与 staged publishing（2025 年后必读）

npm 已于 2025 年停止**新增** TOTP：`npm profile enable-2fa` 会返回
`404 – Adding a new TOTP 2FA is no longer supported`，只剩安全密钥 / Passkey（WebAuthn）。而发布规则变成“**发布必须带 2FA，或带 bypass-2FA 的 granular token**”，且 bypass token **只能暂存、不能直发**：

```
npm publish        → 403 E_STAGE_REQUIRED
                     "this token can only publish to a staging area"
npm stage publish  → 成功，输出 staged id
npm stage approve  → 需要 2FA（proof-of-presence），由浏览器完成
```

因此**首次发布在无硬件密钥时的唯一路径**是「电脑 stage + 手机 approve」：

1. 电脑：`npm stage publish`（bypass-2FA granular token 写进 `~/.npmrc`）
2. 终端报 `EOTP` 并打印 `https://www.npmjs.com/auth/cli/<id>`（TTY 下才完整显示，管道里会被打码成 `***`）
3. 手机 Chrome **先登录 npmjs**（未登录会被重定向回首页），再打开该链接，用 passkey 确认
4. 终端保持运行（它每几秒轮询 `/-/v1/done?authId=…`），成功后打印 `+ pi-living-memory@<版本>`

四个实测过的坑：

- **链接 60 秒级过期**：复制到手机再打开要快，超时就重跑命令拿新 authId；
- **别扫码**：Linux 版 Chrome 没有实现 hybrid/caBLE，「手机当安全密钥」在桌面上必然连不上（与本机 IPv6/局域网无关）；
- **`approve` 在 `validating` 期间报 `404 staged version not found`**：等 `npm stage list` 里状态变成 `staged`（扫描校验通常 1–3 分钟）再 approve；
- **暂存版本与已发布版本共用版本号空间**：暂存了 0.1.10 就不能再发 0.1.10，丢弃用 `npm stage reject <id>`。

stage 与 approve 是两次独立请求，可分布在不同设备：**stage 跟着源码走，approve 跟着你的认证器走**。有 USB 安全密钥时两者都在电脑；CI（GitHub Actions）可以 stage，人在手机上 approve——这正是 staged publishing 的设计意图。

`npm stage list [<pkg>]` 查看、`npm stage view <id>` 看详情、`npm stage download <id>` 取回 tarball 做检查。

