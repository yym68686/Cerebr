# Cerebr Sync

源码随 Cerebr 主仓库发布在 `services/sync/`；以下命令均在本目录执行。

独立的 Cerebr 同步后端和管理控制台。Node.js 24、Fastify、React/Vite、PostgreSQL；REST 负责账号和管理，WebSocket 负责版本化历史与实时生成进度。

## 启动

复制 `.env.example` 为 `.env`，生成独立的数据库密码与初始管理员密码，然后运行：

```sh
docker compose up --build -d
```

管理后台与 API 监听 8080，PostgreSQL 仅容器内可达。管理员仅在用户名不存在时初始化，后续部署不会覆盖密码。用户密码使用 scrypt，会话令牌仅哈希后入库；客户端登录令牌在客户端本地保存，不参与同步。

新账号必须使用邮箱地址注册（最多 254 位）；已有普通用户名账号仍可登录。注册与登录均去除账号名前后空格并统一转为小写；邮箱仅用作账号名，不发送验证邮件。密码保持原样，长度为 10–128 位。

网页版 `https://cerebr.fugue.pro` 与同步管理站点默认允许跨域 REST 和 WebSocket 连接；其它网站通过 `ALLOWED_ORIGINS` 配置，Compose 默认包含其余官方托管地址。新增网页域名时同步更新此配置，并验证注册预检请求。

开发：`npm ci`、`npm run build`、`npm start`。测试使用独立 PostgreSQL，并在 `.env.test` 设置 `DATABASE_URL`；`npm test` 会清空测试库的业务表，不可指向生产库。

## Fugue 部署

同步服务与 Cerebr 客户端独立发布：推送 Cerebr `main` 只会校验本目录，不会自动部署后端。修改后需要部署下面的服务，再从实际网页域名验证 API 和 WebSocket 连接。

```sh
fugue --account yym68686@gmail.com --project cerebr-sync deploy . --create-project --name cerebr-sync --env-file .env
# 后续只更新应用源码，保留现有数据库连接、环境变量与资源预算。
fugue --account yym68686@gmail.com --project cerebr-sync deploy . --app cerebr-sync --build dockerfile --dockerfile Dockerfile --context . --replace-source
# 仅在需要修改 Compose 基础设施时使用完整部署。
fugue --account yym68686@gmail.com --project cerebr-sync deploy . --name cerebr-sync --env-file .env --update-existing
# Compose 部署会重设资源，随后恢复经过大历史校验的资源预算。
fugue --account yym68686@gmail.com --project cerebr-sync app resources auto cerebr-sync --mode recommend
fugue --account yym68686@gmail.com --project cerebr-sync app resources set cerebr-sync --cpu-millicores 250 --cpu-limit-millicores 1000 --memory-mebibytes 512 --memory-limit-mebibytes 1024
```

Fugue 将 Compose 的 postgres 识别为独立 managed PostgreSQL backing service，分配持久卷并重写数据库连接。应用自动分配地址 `https://cerebr-sync.fugue.pro`，无需手动在公网暴露数据库。

## 数据与权限

- 每个同步记录、设备、流量计数和冲突版本均以服务端已认证的 user ID 隔离；客户端不能提交目标 user ID。
- 采用与 Cerebr 本机同步相同的 Lamport 时间戳与 actor 比较，删除保留 tombstone，保留跨 actor 的失败冲突版本。
- SHA-256 完整性摘要递归规范化对象属性顺序，数组顺序和完整消息、附件内容均参与校验。
- 用户暂停：断开云端同步，数据保留；封禁：同时撤销登录会话；管理员可以恢复。离线本地聊天不受影响。
- 用户与客户端的删除按钮仅对普通用户开放，必须输入完整用户名确认。删除在单一事务内清除账号、会话、云端同步记录、冲突版本、客户端和流量，并断开所有服务实例上的连接；管理员账号受保护。审计保留用户名快照和操作记录，设备本地聊天不受影响。同一邮箱可重新注册为新的空账号。
- 后台显示用户、设备、每端对话/消息数、存储字节、上传与下载用量、近 30 天图表及状态变更审计，不提供读取聊天正文或 API 密钥的管理接口。
- 流量是应用 WebSocket 消息的 UTF-8 字节数，不含 TLS/IP 开销。离线客户端数量是最后一次上报的快照。
- PostgreSQL `LISTEN/NOTIFY` 在服务副本间转发记录变更、生成进度和短时实时消息；部署滚动更新时，旧副本收到新副本的变更，通知断线时会让客户端重连追赶。
- 云端是账号同步副本，不替代数据库备份；本机与浏览器原有同步仍独立工作。本服务未实现端到端加密，HTTPS 保护传输，部署管理员具有数据库运维权限。

`server/protocol.js` 与 `server/summary.js` 是客户端协议快照；客户端协议变更时应一起更新并跑跨端测试。

## 共享对话

登录后 `POST /api/shares` 上传 `{chatId,snapshot}`，返回独立的 192 位随机 `shareId`。
同一账号、同一对话重复创建返回原链接且不更新快照。`PUT /api/shares/:id` 显式更新，
`DELETE /api/shares/:id` 停止共享；只有所有者可以操作。删除账号会级联删除其分享，封禁账号的分享不可读取。
`GET /api/shares/:id` 无需登录，仅此公开读取接口允许任意来源跨域访问；错误及成功响应均禁缓存。
公开 ID 不能访问同步记录、设备或账号信息。撤销不删除接收者已经导入的副本。

快照版本 1 为 `{version:1,chat:{title,messages},pages:[{url,title,content,sourceId?}]}`，
消息白名单包含正文、图片、推理、选区引用及附件元数据（包括 PDF 原件）。服务端重新规范化所有字段，
排除原始对话 ID、API 配置与密钥、设备标签页 ID 等私有元数据。单次 HTTP 请求上限 160 MiB，超限拒绝且不截断。
共享快照独立于个人同步记录，不计入后台现有的同步记录及 WebSocket 流量统计。

`cerebr_webpage_source_v1_` 记录承载每个对话用过的网页正文，按网址分别版本化和删除；删除墓碑通过与聊天相同的本机／云端通道保留，过期副本不能恢复已移除的网页。浏览器标签页 ID 不参与复制。
