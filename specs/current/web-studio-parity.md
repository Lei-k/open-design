# 多人 Web Studio parity 架構與驗收

本計畫實作 [Epic 51](https://github.com/Lei-k/open-design/issues/51)：多人登入後使用既有完整 `App → ProjectView → ChatPane/ChatRoot + FileViewer`，並補齊 Web 等價功能。`ConversationRuns` 與 `DesignWorkspace` 是過渡 fallback，不是完成定義。#39 的既有安全設計流程保持可用；不得藉由開放全域 API 取得畫面 parity。

使用者已於 2026-10-06 確認雙帳號訂閱測試及 staging 驗收完成，這兩項不是目前的外部阻塞。新增功能仍須有對應的本地測試及 phase 需求核對；既有驗收不會自動把尚未實作的矩陣列改成完成。

資料路徑遵循根目錄 `AGENTS.md` 的 **Daemon data directory contract**，本文件不另定路徑慣例。

本次交付依使用者最新指示先提交目前工作並開 draft PR。這是 foundation checkpoint，不是 Phase 0 或 Phase 1 完成宣告；不切換完整 App、不移除 fallback，也不關閉 Epic／尚未達驗收的子 issues。

## 權威矩陣

三份 registry 各有單一責任，文件中的摘要不是第二份授權表：

- `packages/contracts/src/api/studio-parity.ts` 的 `STUDIO_PARITY_LANES`：#52 至 #70 的 owner、依賴、共用元件、目標資料歸屬、credential owner、Web 策略與驗收條件。
- `apps/daemon/src/http/studio-parity.ts` 的 `studioRouteParityInventory()`：從 `MULTIUSER_ROUTE_CLASSIFICATION` 逐筆產生 route matrix，涵蓋 allowed、blocked、RegExp、static mount 與 middleware。每筆包含現有單人 API、多人 route class、負責 issue、元件、目標歸屬與 Web 策略。`singleUserApi: null` 表示不是單人 API；public static、middleware、auth 與 multiuser-only 路徑仍有 owner。
- `packages/host/src/studio-parity.ts` 的 `STUDIO_HOST_PARITY`：全部 21 個原生 action 的 Web／daemon 等價方案、authority 與產品待決。`client` 和 `version` 是 runtime metadata，沒有原生動作；Web 使用 browser runtime metadata，不冒充 desktop bridge。

Route matrix 是責任分工，不授予權限。`multiuser-gate.ts` 仍只使用原有 route classification 授權。新增 API domain 或未識別 project 子資源會使 parity test 失敗；daemon 的 live registration 仍必須 100% classified，未知 request 仍 fail closed。Host matrix 用 `OpenDesignHostBridge` 的 mapped type 保證新 action 必須補決策，runtime test 則與完整 mock bridge 比對。

## 共用產品樹與身份邊界

目標拓樸如下；只有 presentation/domain components 共用，authority 始終在 daemon：

```text
ClientApp ── fresh no-store version probe
  ├─ public login and one-use setup entry
  └─ authenticated Studio shell
       └─ StudioSessionProvider
            ├─ actor and generation fenced transports
            ├─ capability and Web host adapters
            ├─ actor-owned settings/catalog/workspace providers
            └─ App → Entry shell / ProjectView
                              └─ ChatPane / ChatRoot + FileViewer
                                      ↓ shared contracts
                               daemon HTTP / SSE authority
                                      ↑ same endpoints
                                od session + od commands
```

`StudioSessionProvider` 已從 fallback 抽出，管理 cookie session、heartbeat、focus／visibility／pageshow、跨 tab invalidation 與 pagehide。`CookieSession` 的 generation fence 拒絕 late JSON／SSE；mutation 被中斷時保留 outcome-unknown，不自動重送。`bindResource` 在身份發布前同步清除註冊的 private 資源。

完整 App 切換前，必須將 `App` 現有 workspace preloader、query cache、catalog cache、active context、draft、workspace tabs、iframe keepalive、analytics／observability 與 Settings 綁到 provider。卸載 React subtree 不等於清除 module-level cache；每項必須註冊 withdrawal cleanup，private storage 使用 actor namespace，cookie/token 不進入 browser storage。角色變更也更換 generation，admin 不保留先前內容樹。

不得複製 `ProjectView`、`ChatPane`、`ChatRoot`、`FileViewer`、Composer、Settings 或 artifact rendering。聊天呈現與事件派生遵循 `specs/current/chat-panel-next.md`、`chat-panel-next-plan.md` 和 chat 層 `AGENTS.md`，共用 `ChatMessage`、`AgentEvent`、run state、question-form 和 `--chat-*` 樣式接縫。多人 adapter 供應正規事件，不把 legacy run card 重新命名成 ChatPanel。

## Capability contract

`AppRuntimeCapabilities.studio` 是 additive、schema version 1 的 `StudioRuntimeCapabilities`，由 daemon 每次 `/api/version` 回應計算且禁止快取。包含 `shell` 及完整 19 lane availability；每個未完成或管理政策禁用項都必須附原因。沒有欄位表示 unknown，不能當成 supported。

目前多人回應 `shell: legacy-multiuser`，只有已閉合的 baseline 可宣告 supported；project 或 execution 的部分 API 開放不代表整個 lane 完成。actor、角色與實際可用 execution source 由 authenticated provider 取得，public version 不攜帶帳號資訊。未來 presentation 只讀 provider 的能力，不到處用 `if (multiUser)` fork 產品，也不藉由探測 403 猜功能。

`supported` 是完整 lane 的交付承諾，不是讀取 owner 資源的授權，更不是把個人憑證降級成公司池的許可。公司池沒有真實 provider 時不可假造可用來源；personal account 的 continuation 保持既有 immutable source/account pin。

## 功能與交付矩陣

表中的 API 是現有單人或既有多人端點的代表。完整逐條 route class、blocked reason 與 owner 以 machine registry 為準；Web 等價欄是架構策略，不表示實作已通過。

| Phase | Issue 與負責範圍 | 共用元件與代表 API | 歸屬及 Web 策略 | 完成條件 |
| --- | --- | --- | --- | --- |
| 0 | #52 contracts 與基線 | App、全部 route inventory、host bridge | public；矩陣共用 | 每條 route 與 native action 都有 owner／決策；新增能力不產生無主差距 |
| 0 | #53 web session | App、Entry shell、router、`/api/auth/*`、`/api/version` | actor/session adapter | 同一 App；身份切換無 private frame；完整 deep links、Settings、mobile nav |
| 0 | #54 daemon project | ProjectView、`/api/projects/:id/conversations/*`、messages、tabs、events | immutable project/actor adapter | A/B/admin negative controls、SSE 隔離、migration 可重跑、legacy rollback |
| 1 | #55 daemon runs | chat runtime、`/api/chat`、`/api/runs/*` | run/actor credential adapter | 正規訊息与事件、隊列、公平性、cancel/steer、replay、restart、account pin |
| 1 | #56 web chat | ChatPane／ChatRoot、標準 messages 與 run SSE | conversation；presentation 共用 | thinking、todo、tools、question-form、錯誤、重連、重試、續接、歷史管理 |
| 1 | #57 web composer | Rich Composer、`/api/upload`、run controls | actor/project adapter | 附件、skills/DS、agent/source 選擇、執行控制、Home handoff exactly once |
| 1 | #58 daemon files | FileViewer、project files/folders/search/upload/version endpoints | project adapter | CRUD、版本與還原、搜尋、watcher invalidation；path、symlink、大小限制 |
| 1 | #59 daemon artifacts | ArtifactCard／FileViewer、preview、chat-artifact-snapshots、comments | artifact/version；preview capability adapter | 全種類預覽、編輯、評論、immutable snapshots、撤銷與跨來源 iframe |
| 2 | #60 web entry | HomeView／NewProjectPanel、projects、import、templates、Figma import | actor/project；browser upload adapter | 六種建立入口、template 套用、upload/import；不接受 daemon host 路徑 |
| 2 | #61 daemon registry | DesignSystemFlow／Marketplace、skills/design-systems/templates/plugins/community | bundled/actor/workspace adapter | public bundled 與 private/team catalog 分離；install/revise/apply 有 immutable snapshot |
| 2 | #62 daemon settings | SettingsDialog／Integrations、app-config、agent-accounts、memory/library/MCP/connectors | actor credentials/config adapter | secrets redacted、OAuth/session revoke、memory/library 隔離、不回讀 daemon 共用密鑰 |
| 2 | #63 daemon generation | Media、LiveArtifacts、GenUI、research、critique APIs | actor/project/run adapter | create → progress → output → preview → revision；背景任務重驗 authority |
| 2 | #64 daemon routines | TasksView、routines、automation proposals/ingestions | actor schedule adapter | owner 綁定、每次 dispatch 重驗 account/credential、cancel/history/output 隔離 |
| 3 | #65 daemon collaboration | Workspace、presence、comments、collab、shared resources | workspace credential binding；產品待決 | 明確 Web account/Vela member binding；membership 撤銷立即關閉資料與 stream |
| 3 | #66 daemon delivery | FileViewer export/share/deploy/finalize/handoff APIs | owner/project/version；daemon renderer | isolated headless exports、digest 綁定、下載撤銷、actor provider credentials |
| 3 | #67 host | 全部 native bridge、dialog/open-in/terminals/browser/host ops | actor 或 admin；browser/daemon/產品待決 | 所有 Web 等價或逐項產品簽核；不暴露 host-global 操作 |
| 3 | #68 daemon CLI | `od` commands 對相同 HTTP/SSE | origin-pinned session adapter | HTTPS、secret file/stdin、JSON、prompt-file、cancel/resume、stream cursor、A/B 及撤銷測試 |
| 3 | #69 daemon admin | 共用 App 內 Users／Audit／Pool、auth/admin endpoints | admin metadata；presentation 共用 | 導覽整合、role/quota/capacity、no secret reads、無 project-content bypass |
| 3 | #70 e2e | 上述全部矩陣與 rollback | two-session acceptance | 同 build 單人/A/B、desktop/mobile、visual/a11y/perf、撤銷/restart、舊殼移除 |

依賴的完整 DAG 在 `STUDIO_PARITY_LANES`。核心順序是 `#52 → #53/#54 → #55 → #56/#57 → #58/#59`；Phase 2 及 3 的後端研究可先做，但不得跳過其 authority 依賴宣告驗收完成。

## Web 原生決策

Host registry 覆蓋 appearance、browser cache、capture、PDF、pet、preview diagnostics、三種 folder 操作、外部連結、openPath 與九種 updater actions。Browser upload、受限外部導覽、主題與 frame lifecycle 用 browser adapter；capture/print 用 owner snapshot 與 isolated daemon renderer。任何套件安裝、daemon shutdown、shared cache 清除或 OS shell 都不能因 UI parity 開給一般 actor。

仍需產品簽核的項目為 `pet.setVisible` 的 OS overlay 等價、`shell.openPath` 的 archive／本機 handoff，以及 `updater.clear-cache/download/install` 的 browser 與 server 管理範圍。這些項目保留為 product-decision，不是已批准 Web 不適用。Workspace 的本地 account／Vela member binding 同樣須明確決策，不能重用 `x-od-*` 作身份。

## Authority 與相容遷移

服務端從 `__Host-od_session` 解出 actor，先授權再查內容，foreign／missing 共用拒絕結果，admin 無 private project bypass。標準 conversations 的 title/mode body、messages 的內容 body 和 tabs body 有 allowlist；client 不得改 parent、runId、owner、event 或 artifact binding，也不得建立 remote host browser tabs。

Run admission 在同一 SQLite transaction 建立正規 user／assistant messages；daemon 為兩者簽發 deterministic ids，避免 client-chosen message id 的跨租戶 collision oracle。assistant run 欄位與內容維持 daemon single writer。`multiuser_studio_turns` 以 immutable run/message binding 連接既有資料；只 backfill owner/project/conversation 一致的 rows，不自動認領 unbound legacy 資料。原有 run/event tables 保留，舊殼仍可讀，migration 可重跑且保留 user 編輯。部署回滾前照既有 backup/restore 規約備份，不以破壞性 schema 回退作產品切換。

刪除 project/conversation 先封住同一 target 的新任務准入，取消 owned queued/active workers，等待 subprocess exit，刪除 parent/files 後才釋放鎖。非同步 prompt I/O 完成後重驗 target 與 session。Project SSE 及 run SSE 每次 payload 重驗 persisted session/account/role 和 resource owner，idle stream 一秒內撤銷，disconnect 清除 watcher/listener/timer；SSE 不延長 session idle TTL。

`/api/active` 在多人模式以 authenticated session 隔離，GET／POST 在 project metadata lookup 前檢查 owner；另一次登入不繼承前一 session 的焦點。state 有 TTL 與容量上限，project 刪除後讀取立即變為 inactive；本機 MCP 的 legacy global context 不與多人 session 共用。既有 App 的焦點回報使用 shared DTO，`od project active` 提供相同 API 的 read/set/clear。

Preview 延續既有獨立 HTTPS hostname、opaque-origin sandbox、短效 owner/session-bound capability；不得替換成同源 `srcdoc` 任意 HTML 或 bearer credential URL。Frame renew、snapshot、comment、export 與背景 jobs 仍各需完整 lineage/authority closure，不能由 project list 安全推論全部安全。

## Rollout 與回滾

切換前保持 `ClientApp` 的 no-store runtime probe 和 legacy fallback。未完成 lane 保留明確 reason；新 registry／能力欄位不自行開 route、不自行切 App。逐 lane 完成後先跑 ownership positive 與 A↔B/admin negative，再測 shared provider 和 presentation；同一 build 對照單人與多人，不以不同版本截圖作 parity。

正式 rollout 以 daemon 的 capability contract 為唯一判定，不使用 client storage 開關或 query-string 改 authority。所有 mandatory lane、Web 等價／產品決策、local checks 與 #70 驗收閉合後才可回應 `shell: studio`；管理員的 server policy 可以停用特定 capability，但 UI 必須顯示原因。未來 pilot/rollback 的操作者入口及 audit contract 必須在切換實作一起交付。

Telemetry 只記錄 schema/build、lane、shell transition、固定 denial code 及 aggregate failure count；不記錄帳號、prompt、message、路徑、cookie、credential、preview URL 或檔案內容。Identity withdrawal 的事件只報原因類別。Telemetry 走 actor-aware／admin-owned endpoint，禁止重新開放現有 host-global analytics 以取得報表。

Rollback 把 shell advertisement 回到 legacy，先同步清除新 Studio private tree/cache/streams/frames，再重新驗證 session 才掛 fallback；additive message migration 不回刪。只有全部矩陣通過、rollback 已驗證、所有 Web 不適用有逐項產品簽核，才移除重複 Studio 元件；保留所需 login/setup 身份入口和共用 App 的 admin presentation。

## CLI session 與威脅模型

第一個 remote adapter 選擇既有 password flow，直接呼叫 `/api/auth/login`，不新增 admin-issued bearer token 或第二套身份服務。`od session login` 必須指定 server origin、username、`--password-file <path|->` 及 `--session-file <path>`；`session me` 顯示 public account metadata，`session logout` 由服務端撤銷後才刪除該 credential file。不同帳號使用各自顯式選擇的檔案，不自動沿用上一帳號或探索其他 session。

Session file 以 exclusive create、0600、no-follow、opened-inode owner/mode/size 檢查保護，拒絕 symlink parents、hard links、未知欄位及過期 session；existing file 不覆蓋。CLI 不在 argv、environment、stdout/stderr 或 browser storage 放 cookie/password，不將 daemon credential 當 auth session。Password stdin 有大小界限；password file 也必須 private 且同 OS principal。選擇其他帳號時先用 `session me` 核對身份；同一 OS principal 已能讀取自己的 credential files，此模型不宣稱隔離同 UID 的惡意程序。

Remote origin 只接受 HTTPS，HTTP 只准 numeric loopback 的本地測試／開發。拒絕 URL userinfo、子路徑、query/fragment、origin mismatch、所有 redirect 及 TLS verification bypass。Transport 只對 pinned-origin `/api/*` 送 session，剝除 Authorization 和 `x-od-*`，因此現有 command helpers 不能把 cookie 送到其他 server，也不能重用本機 Vela workspace 作遠端身份。Local lifecycle 與未審核的 host commands 回固定 capability-pending error，不啟動／停止另一個 daemon。

已接上的 CLI 是 project create/list/info、tabs/events/active、standard conversation create/update/delete/messages/message-update，以及 run start/watch/cancel；prompt-file 支援 stdin，run watch 輸出帶 event id 的 ND-JSON，`--last-event-id` 對同 run 的 durable seq 續讀。API admission 回 additive `runId` 保持標準 command 和 legacy `run` 相容。Server cursor 先經 owner 授權再驗證，不能用 foreign cursor 探索其他 run。EOF 必須有 terminal event 或經 owned run GET 確認終態，不能將撤銷／中斷誤報為成功。仍需完成 normalized rich chat、question answer、各 catalog/settings/media/automation/export lane 和其 E2E，不能因此關閉 #68。

## Phase 核對紀錄

每次 phase 收尾必須回讀 parent 和該 phase 的子 issues，逐項記錄實作入口、測試、跨帳號 negative control、CLI surface 與未通過項目。實作完成、測試通過、產品驗收是不同欄位，不用測試數取代需求 closure。

| 範圍 | 本地實作與證據 | 尚未通過的需求 | 判定 |
| --- | --- | --- | --- |
| #52 | 三份權威 registry、runtime contract、本架構文件；daemon parity tests、host mapped-type 及 native action coverage | 後續新能力必須繼續補 matrix | 基線交付，非 Studio 完成 |
| #53 | 共用 `StudioSessionProvider`、generation transport、synchronous resource cleanup；entry/session tests | 完整 App/providers、cache/draft/tab/frame 全量註冊、deep links/mobile/Settings | 未完成 |
| #54 | 標準 conversations/messages/tabs/events 授權、session-scoped active context、bounded body、immutable message bindings、刪除等待 workers；HTTP/SSE、migration/reopen/rollback 與 scoped CLI tests | 全量 artifact/upload/background lineage、完整 App provider closure | 未完成 |
| #55 | run admission/terminal state 與標準 transcript 同 transaction、durable cursor replay，既有 personal source/account pin 保留；run HTTP regressions | normalized rich events、steer/restart acceptance、標準 chat pipeline 全量整合 | 未完成 |
| #68 | pinned-origin password session、private files、JSON/prompt-file、run cursor；CLI transport 與 real-daemon A/B tests | rich headless chat 與其餘 domain lanes、TLS MITM integration acceptance | 未完成 |
| Phase 0 | #52 基線及 #53/#54 上述基礎 | #53/#54 的剩餘驗收不可跳過 | 不可標記完成 |
| Phase 1 至 3 | 後續逐 lane 實作並核對；既有兩帳號訂閱和 staging 已由使用者確認 | 完整功能、UI/CLI、全矩陣驗收及舊殼下線 | 不可標記完成 |

目前本地驗證入口：

```bash
pnpm guard
pnpm typecheck
pnpm --filter @open-design/host test
pnpm --filter @open-design/daemon exec vitest run -c vitest.config.ts tests/auth/studio-parity.test.ts tests/auth/studio-project-http.test.ts tests/auth/multiuser-stream.test.ts tests/auth/multiuser-gate-http.test.ts tests/auth/multiuser-route-classes.test.ts tests/auth/auth-service.test.ts tests/auth/multiuser-runs-http.test.ts tests/auth/multiuser-personal-runs-http.test.ts
pnpm --filter @open-design/web exec vitest run -c vitest.config.ts tests/multiuser/entry.test.tsx tests/multiuser/session.test.ts tests/multiuser/conversations.test.tsx tests/multiuser/runs.test.tsx
pnpm --filter @open-design/daemon exec vitest run -c vitest.config.ts tests/auth/cli-session.test.ts tests/auth/studio-cli-http.test.ts tests/auth/studio-messages-migration.test.ts
```
