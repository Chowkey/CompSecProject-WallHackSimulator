# Prompt: Client Integrity Sandbox — mô phỏng 5 kỹ thuật anti-cheat và giới hạn của chúng

> Dán toàn bộ nội dung dưới đây vào Claude Code / Cursor / ChatGPT để sinh dự án.
> Phần "Bối cảnh học thuật" nên giữ nguyên — nó xác định phạm vi và mục tiêu giáo dục của đồ án.

---

## Bối cảnh học thuật

Đây là đồ án cuối kỳ môn An toàn thông tin. Mục tiêu là xây dựng một **sandbox mô phỏng khép kín** để chứng minh bằng thực nghiệm một luận điểm trong bảo mật hệ thống:

> Mọi cơ chế kiểm tra tính toàn vẹn chạy trên máy do đối phương kiểm soát đều chỉ là **lời tự khai**, không phải bằng chứng. Chúng chỉ tăng chi phí tấn công chứ không tạo ra đảm bảo.

Toàn bộ "game", "server", và "kẻ tấn công" đều là code do chính dự án viết ra, chạy trong cùng một trang web. Dự án **không** nhắm vào bất kỳ phần mềm thương mại nào, không tạo ra công cụ dùng được ngoài sandbox, và không chứa kỹ thuật né tránh anti-cheat thật. Mọi "cheat" trong dự án chỉ thao tác trên đối tượng JavaScript của chính dự án.

Sản phẩm phải phục vụ được hai việc: **demo trực tiếp** trước hội đồng, và **xuất số liệu** để đưa vào báo cáo.

---

## Yêu cầu kỹ thuật tổng quát

- **Stack**: Vanilla JavaScript + HTML Canvas. Không framework, không build step. Ưu tiên chạy được bằng cách mở file trực tiếp hoặc `python -m http.server`.
- **Cấu trúc file**: tách module rõ ràng (`server.js`, `client.js`, `defenses.js`, `attacker.js`, `ui.js`, `main.js`). Việc tách file là một phần của nội dung — nó tạo ra ranh giới để minh họa khái niệm "module registry" và "code signing".
- **Tính tái lập**: dùng PRNG có seed (mulberry32 hoặc tương đương). Cùng một seed phải cho ra cùng một kết quả. Ghi seed lên UI.
- **Điều khiển thời gian**: có nút Play / Pause / Step-1-tick / đổi tốc độ (0.25x → 4x). Hội đồng cần dừng lại đúng khoảnh khắc một defense bị bypass.
- **Không phụ thuộc mạng**: mọi thứ chạy offline.

---

## Kiến trúc mô phỏng

Ba lớp logic, tách biệt nghiêm ngặt:

### 1. `server.js` — Authoritative server (chạy trong Web Worker)

Việc đặt server trong Web Worker là **có chủ đích**: nó tạo ranh giới bộ nhớ thật giữa server và client, giúp minh họa vì sao logic phía server không bị cheat sửa được. Nêu rõ điều này trong comment.

Server giữ trạng thái thật (ground truth):
- Bản đồ 2D dạng lưới ô (khoảng 40×30), có tường
- 1 người chơi (do người dùng điều khiển) + 5–7 NPC di chuyển theo đường đi định sẵn hoặc random-walk có seed
- Mỗi tick (20 Hz): tính line-of-sight từ người chơi tới từng NPC bằng thuật toán Bresenham raycast trên lưới

Server có **công tắc `CULLING_MODE`** với ba giá trị:

| Chế độ | Hành vi | Ý nghĩa minh họa |
|---|---|---|
| `NONE` | Gửi toàn bộ NPC kèm tọa độ chính xác | Kiến trúc naive — wallhack hoạt động 100% |
| `STRICT` | Chỉ gửi NPC đang có line-of-sight | Chống wallhack tuyệt đối, nhưng NPC "pop-in" đột ngột |
| `BUFFERED` | Gửi NPC đang thấy + NPC nằm trong bán kính có thể lộ diện trong 300ms tới | Kiến trúc thực tế — mượt mà nhưng **rò rỉ** |

Chế độ `BUFFERED` là điểm nhấn học thuật: nó cho thấy đánh đổi giữa trải nghiệm người chơi và bề mặt tấn công. Cheat vẫn thấy trước ~300ms, và UI phải làm nổi bật những NPC "rò rỉ" này bằng màu riêng.

### 2. `client.js` — Game client

- Nhận packet từ server, lưu vào `clientState.entities`
- Vẽ **hai canvas**:
  - **Canvas chính**: góc nhìn người chơi, chỉ vẽ những gì client được phép biết
  - **Minimap**: fog of war, chỉ hiện NPC có `visible === true`
- Đăng ký mọi hàm quan trọng vào `moduleRegistry` (dùng cho defense #3)
- Điều khiển: WASD hoặc phím mũi tên

### 3. `attacker.js` — Kẻ tấn công mô phỏng

Được nạp **sau** client (mô phỏng injection lúc runtime). Có ba cấp độ chọn được từ UI:

- **Level 1 — Passive read**: chỉ đọc `clientState.entities` và log ra terminal. Không sửa gì.
- **Level 2 — Wallhack**: hook hàm `renderMinimap`, vẽ thêm mọi NPC có trong `clientState` bất kể `visible`. Đây là phần trực quan nhất của demo.
- **Level 3 — Evasive**: bật đầy đủ các kỹ thuật bypass 5 defense bên dưới.

---

## Phần cốt lõi: 5 defense × 2 trạng thái

Đây là trọng tâm của đồ án. Mỗi defense phải:
- Bật/tắt được độc lập bằng checkbox trên UI
- Có ô chọn riêng **"Attacker bypass"** để bật/tắt kỹ thuật vô hiệu hóa tương ứng
- Log chi tiết mỗi lần chạy: kết quả, thời gian thực thi (ms), và lý do nếu bị qua mặt
- Đếm số lần phát hiện đúng / bỏ sót (cho bảng số liệu)

### Defense 1 — Code checksum

**Cơ chế**: Lúc khởi tạo, băm mã nguồn các hàm quan trọng (`fn.toString()`) bằng SHA-256 qua Web Crypto API, lưu vào `baselineHashes`. Mỗi 500ms, băm lại và so sánh.

**Phát hiện được**: attacker ghi đè trực tiếp `client.renderMinimap = function() {...}` → hash đổi → cảnh báo.

**Bypass**: attacker ghi đè `Function.prototype.toString` cho hàm đã hook, trả về mã nguồn gốc đã lưu sẵn. Hash khớp, defense báo "sạch" trong khi hành vi đã đổi.

**Bài học ghi trong log**: "Hàm kiểm tra phải *đọc* đối tượng cần kiểm tra. Kẻ tấn công kiểm soát thao tác đọc đó." — đây chính là analog trực tiếp của kỹ thuật giữ bản sao vùng `.text` trong RAM ở môi trường native.

### Defense 2 — Hook detection

**Cơ chế**: Lưu tham chiếu gốc của các hàm quan trọng vào một `Map` đóng kín (dùng closure, không expose ra global). Định kỳ so sánh `client.renderMinimap === pristineRefs.get('renderMinimap')`. Ngoài ra kiểm tra `fn.name` và `fn.length` có khớp không.

**Phát hiện được**: mọi kiểu wrap hàm đơn giản.

**Bypass**: attacker cài "trampoline" — khôi phục tham chiếu gốc ngay trước khi hàm kiểm tra chạy và hook lại ngay sau đó. Mô phỏng bằng cách để attacker cũng hook luôn hàm kiểm tra (`checkHooks`) và tự vô hiệu hóa mình trong thời gian ngắn đó.

**Bài học**: "Hàm kiểm tra cũng chỉ là một hàm — nó hook được y như mọi hàm khác. Không có gốc tin cậy trong ring 3."

### Defense 3 — Module enumeration

**Cơ chế**: `moduleRegistry` chứa danh sách module hợp lệ kèm hash. Quét toàn bộ `window` (hoặc một namespace giả lập `processMemory`) tìm những đối tượng hàm **không thuộc module nào đã đăng ký** — analog của việc quét vùng nhớ có quyền thực thi không thuộc module nào.

**Phát hiện được**: attacker Level 2 nếu nó tự đăng ký hoặc để lại dấu vết trên global scope.

**Bypass**: attacker dùng kỹ thuật "manual mapping" mô phỏng — không thêm gì vào global, chỉ sửa **biến trong closure** của module đã có sẵn. Không có module mới nào xuất hiện, quét không ra gì.

**Bài học**: "Danh sách module là do hệ thống tự khai. Code không đăng ký thì không có trong danh sách."

### Defense 4 — Code signing / signature verification

**Cơ chế**: Mỗi module có chữ ký HMAC-SHA256 tính lúc "build" (hardcode trong `manifest.json`). Lúc nạp, client verify từng module. Module sai chữ ký → từ chối nạp.

**Phát hiện được**: sửa file module trên "đĩa".

**Bypass**: attacker được nạp **sau khi quá trình verify đã hoàn tất** — mô phỏng `@run-at document-start` của userscript và mô phỏng việc cheat sửa RAM chứ không sửa file. Mọi chữ ký vẫn hợp lệ, `manifest` vẫn khớp, nhưng hành vi đã đổi.

**Bài học**: "Chữ ký chứng minh file lúc nạp, không chứng minh trạng thái lúc chạy."

### Defense 5 — Challenge–response (defense mạnh nhất)

**Cơ chế**: Server (trong Worker) chủ động ra đề:
1. Chọn ngẫu nhiên `{ moduleId, offset, length, nonce }`
2. Gửi challenge, đặt deadline (ví dụ 200ms)
3. Client băm `source.slice(offset, offset+length) + nonce`, gửi về
4. Server tự tính đáp án đúng từ bản gốc nó giữ, so sánh cả **giá trị** lẫn **độ trễ**

**Phát hiện được**: mọi kỹ thuật bypass ở defense 1–4 nếu attacker không chuẩn bị riêng cho cơ chế này. Vì đề thay đổi mỗi lần, không thể cache đáp án. Nonce chống replay.

**Bypass**: attacker giữ một `pristineSourceCache` — bản sao nguyên vẹn toàn bộ mã nguồn, chụp lại **trước khi** hook. Mọi challenge đều trả lời đúng.

**Nhưng — điểm quan trọng nhất của đồ án**: thêm công tắc `TIMING_ANALYSIS` phía server. Việc trả lời từ cache gián tiếp tốn thêm thời gian. Cho attacker có tham số `bypassOverheadMs` (0–50ms) điều chỉnh được. Server dựng phân phối độ trễ và cảnh báo khi phát hiện lệch bất thường (ví dụ z-score > 3 so với baseline).

Đây là **defense duy nhất trong năm cái vẫn còn thắng được** ở một số cấu hình, và nó minh họa nguyên lý: khi không thể tin vào *nội dung* câu trả lời, hãy đo *đặc tính vật lý* của quá trình tạo ra câu trả lời. Cho hội đồng thấy vùng tham số nơi phòng thủ thắng và vùng nơi nó thua.

---

## Giao diện

Bố cục 3 vùng:

```
┌──────────────────────────┬─────────────────┐
│                          │   MINIMAP       │
│    GAME VIEW (canvas)    │  (fog of war)   │
│    Góc nhìn người chơi   ├─────────────────┤
│                          │  DEFENSE PANEL  │
│                          │  5 checkbox     │
│                          │  + bypass toggle│
├──────────────────────────┴─────────────────┤
│  TERMINAL LOG (cuộn, có màu, lọc được)     │
└────────────────────────────────────────────┘
```

**Minimap** — trọng tâm trực quan. Vẽ NPC bằng 4 màu khác nhau:
- **Xanh lá**: NPC hợp lệ, đang có line-of-sight
- **Vàng**: NPC bị rò do buffer 300ms (chỉ xuất hiện ở chế độ `BUFFERED`)
- **Đỏ**: NPC chỉ hiện nhờ wallhack — server có gửi nhưng client lẽ ra phải giấu
- **Xám mờ**: last-known-position

Khi bật/tắt cheat, người xem phải thấy ngay sự khác biệt trên minimap. Đây là khoảnh khắc "aha" của bài demo.

**Defense panel** — mỗi dòng hiển thị:
```
☑ Checksum        [BYPASSED]  detect: 0/47   avg 2.3ms
☑ Hook detection  [ACTIVE]    detect: 12/47  avg 0.8ms
☑ Challenge-resp  [ACTIVE]    detect: 41/47  avg 18.4ms
```

**Terminal** — log có mã màu, có nút lọc theo nguồn:
```
[t=12.40s][SERVER  ] tick 372 · culling=BUFFERED · sent 4/7 (2 leaked by buffer)
[t=12.41s][CHEAT   ] read clientState.entities → 4 entities
[t=12.41s][CHEAT   ] renderMinimap hooked · drawing 4/4 (2 through walls)
[t=12.45s][DEF:sum ] hash renderMinimap = 9f3a1c… ✓ MATCH
[t=12.45s][DEF:sum ] ⚠ FALSE NEGATIVE — toString() spoofed, function is hooked
[t=12.50s][DEF:chal] challenge {mod:client, off:412, len:256, nonce:7f3a92}
[t=12.52s][DEF:chal] response ✓ correct · latency 21.4ms (baseline 3.1ms)
[t=12.52s][DEF:chal] ⚠ ANOMALY — latency z-score 6.2, flagging session
```

Terminal là nơi thể hiện chiều sâu kỹ thuật khi chấm điểm. Log phải đủ chi tiết để người đọc theo dõi được từng bước, và mỗi lần bypass thành công phải kèm dòng giải thích **vì sao** defense thất bại.

---

## Xuất dữ liệu cho báo cáo

Bắt buộc có nút **Export session** ghi ra JSON + CSV gồm:

- Cấu hình: seed, culling mode, defense nào bật, bypass nào bật
- Ma trận kết quả: mỗi cặp (defense × attacker level) → detected / missed / false positive
- Chi phí: thời gian thực thi trung bình của từng defense (ms/tick), tổng % CPU budget
- Với challenge–response: toàn bộ dãy latency để vẽ histogram

Thêm một **chế độ Benchmark** chạy tự động toàn bộ ma trận (5 defense × 3 attacker level × 3 culling mode = 45 tổ hợp), mỗi tổ hợp 500 tick, rồi xuất bảng tổng hợp. Đây là phần biến đồ án từ "demo" thành "nghiên cứu có số liệu".

---

## Nội dung giáo dục kèm theo

Mỗi defense có nút `?` mở panel giải thích:
- Cơ chế tương ứng trong thế giới thật (kèm tên API Windows tương ứng để đối chiếu lý thuyết)
- Vì sao bypass được
- Chi phí triển khai thực tế

Cuối cùng, thêm một **panel kết luận** tự động sinh sau khi chạy benchmark, tóm tắt:
- Tổng số defense bị vượt qua ở attacker level 3
- Đối chiếu: ở chế độ `STRICT`, cheat level 2 thu được **0 thông tin** dù **không defense nào bật** — chứng minh rằng kiến trúc server quan trọng hơn toàn bộ 5 lớp phòng thủ client-side cộng lại
- Ở chế độ `BUFFERED`, lượng rò rỉ đo được là bao nhiêu ms và bao nhiêu % số tick

Điểm kết luận này là luận điểm chính của báo cáo. Toàn bộ phần còn lại tồn tại để chứng minh nó bằng số liệu.

---

## Thứ tự triển khai đề xuất

1. Server + client + minimap fog of war (chưa có cheat, chưa có defense)
2. Ba chế độ culling + hiển thị NPC rò rỉ
3. Attacker level 1–2 + wallhack trên minimap
4. Terminal log với đầy đủ mã màu
5. Defense 1–4, mỗi cái kèm bypass tương ứng
6. Defense 5 + phân tích timing
7. Benchmark mode + export
8. Panel giáo dục + panel kết luận

Sau mỗi bước phải chạy được và demo được — đừng để đến cuối mới ráp.

---

## Case study tham chiếu: Riot Games

Đồ án lấy kiến trúc anti-cheat của Riot Games làm hệ quy chiếu thực tế. Riot là trường hợp lý tưởng vì họ triển khai **đồng thời cả hai lớp** mà mô phỏng này so sánh — và họ công bố công khai về cả hai.

### Lớp client: Vanguard

Vanguard gồm hai thành phần: <cite index="3-1">một client chạy ở user mode (`vgc.exe`) hiện trong khay hệ thống, và một driver kernel (`vgk.sys`) chạy với đặc quyền cao nhất mà Windows cho phép</cite>. Driver này được đăng ký là boot-start service, tức nạp trong giai đoạn khởi động sớm của Windows.

Lý do Riot chọn thiết kế gây tranh cãi này chính là **bài toán "ai nạp trước"** mà đồ án cần minh họa: <cite index="4-1">nếu Vanguard chỉ nạp khi game khởi động, một driver cheat nạp sớm hơn đã có thể vá các cấu trúc kernel mà Vanguard dựa vào để kiểm tra</cite>. Kỹ sư Riot gọi đây là vấn đề "first mover", và câu trả lời của họ là luôn đi trước ở phía phòng thủ.

Đây chính xác là điều mà **Defense 4 (code signing)** trong mô phỏng minh họa: attacker được nạp sau khi verify xong thì mọi chữ ký vẫn hợp lệ. Trong sandbox JS, tương đương với `@run-at document-start` của userscript.

### Bước ngoặt tháng 6/2026 — Vanguard On-Demand

Đây là diễn biến mới nhất và nên đưa vào phần "Kết quả & Thảo luận" của báo cáo.

Riot đã triển khai chế độ **Vanguard On-Demand**: <cite index="5-1">driver kernel không còn nạp lúc boot mà chỉ nạp khi người chơi khởi động game, rồi gỡ ra khi thoát</cite>. Cơ chế hoạt động: <cite index="5-1">client user-mode trước tiên thực hiện attestation qua TPM để xác minh hệ thống chưa bị can thiệp, sau đó mới yêu cầu Windows nạp driver đã ký; trong suốt phiên chơi, driver duy trì môi trường được bảo vệ bằng virtualization-based security</cite>.

Điều kiện: <cite index="6-1">TPM 2.0, Secure Boot, và CPU hỗ trợ VBS; cơ chế attestation của Microsoft xác thực chuỗi khởi động, hypervisor và tính toàn vẹn hệ điều hành trước khi Vanguard được chuyển sang chế độ on-demand</cite>. <cite index="6-1">Nếu hệ thống không qua được kiểm tra nào, Vanguard quay về chế độ always-on cũ.</cite>

**Vì sao điều này quan trọng với đồ án:** nó cho thấy ngành đang dịch chuyển từ "tin vào việc driver nạp trước" sang "tin vào chứng thực phần cứng". Thay vì tự chứng minh mình sạch bằng phần mềm — vốn là điểm thất bại chung của cả 5 defense trong mô phỏng — hệ thống dùng một gốc tin cậy nằm ngoài tầm với của phần mềm, đó là chip TPM. Đây là câu trả lời trực tiếp cho nghịch lý "ai kiểm tra người kiểm tra".

Nhưng giới hạn vẫn còn, và báo cáo nên nêu: attestation chỉ chứng minh **chuỗi khởi động**, không chứng minh trạng thái RAM trong lúc chơi. Nó không thấy cheat inject sau khi boot xong, và không thấy card DMA.

### Lớp server: Fog of War

Đây là phần Riot công bố trong bài kỹ thuật *Demolishing Wallhacks with VALORANT's Fog of War*, và nó là nguồn tham chiếu trực tiếp cho ba chế độ culling trong mô phỏng.

Nguyên lý: <cite index="12-1">thay vì liên tục cập nhật vị trí đối thủ cho client, server chờ đến ngay trước khi họ thực sự lộ diện mới gửi dữ liệu đó</cite>.

Quan trọng hơn cho đồ án là **quá trình họ thất bại rồi sửa**. Riot mô tả ba lần thử: <cite index="10-1">lần đầu tập trung vào tính toán line-of-sight bằng cách thêm raycast kiểm tra các cạnh của bounding box, nhưng không xử lý được pop-in; lần hai mở rộng bounding box để bắt các hành động sắp xảy ra, nhưng kiểm tra line-of-sight vẫn quá bi quan; lần ba kết hợp việc "nhìn vào tương lai" của lần hai với occlusion culling để thay thế raycast thiếu tin cậy</cite>.

Ba lần thử này ánh xạ gần như một-một sang ba chế độ culling trong mô phỏng:

| Riot | Chế độ trong sandbox | Vấn đề bộc lộ |
|---|---|---|
| Raycast thuần | `STRICT` | Pop-in, quá bi quan |
| Mở rộng bounding box | (bước trung gian) | Vẫn chưa đủ |
| Nhìn trước + occlusion culling | `BUFFERED` | Mượt, nhưng rò rỉ thông tin |

Việc mô phỏng tái hiện được cả đường đi này — chứ không chỉ kết quả cuối — là điểm mạnh khi trình bày.

### Điều Riot thừa nhận kernel không làm được

Ngay cả với Vanguard ở ring 0, có những thứ nằm ngoài tầm. Một phân tích chỉ ra rằng thao túng chỉ số, boosting và các hành vi tương tự <cite index="9-1">nằm ngoài mô hình đe dọa của Vanguard vì người chơi thực sự là con người bấm phím thật; hành vi lạm dụng nằm ở phía matchmaking, và kernel không nhìn thấy được</cite>. Đó là lý do <cite index="9-1">Riot đầu tư mạnh vào phân tích phía server để bắt những gì driver client-side không bắt được</cite>.

Điểm này khép lại luận điểm của đồ án: kể cả nhà phát hành có nguồn lực lớn nhất, triển khai anti-cheat client-side sâu nhất ngành, vẫn phải dựa vào lớp server cho phần lớn bài toán.

### Bảng ánh xạ: sandbox ↔ thực tế

Đưa bảng này vào báo cáo để chứng minh mô phỏng có cơ sở thực tiễn.

| Thành phần trong sandbox | Đối chiếu thực tế |
|---|---|
| Defense 1 — checksum + toString spoofing | Băm vùng `.text`, bypass bằng bản sao nguyên gốc trong RAM |
| Defense 2 — hook detection | Kiểm tra prologue hàm, IAT integrity |
| Defense 3 — module enumeration | Quét vùng nhớ executable không thuộc module; đối phó manual mapping |
| Defense 4 — code signing, attacker nạp sau | Vanguard boot-start và bài toán "first mover" |
| Defense 5 — challenge–response + timing | Attestation phía server; TPM attestation của Vanguard On-Demand |
| `CULLING_MODE = NONE` | Kiến trúc netcode truyền thống (CS:GO gốc, phần lớn game web) |
| `CULLING_MODE = STRICT` | Lần thử raycast đầu của Riot — đúng nhưng gây pop-in |
| `CULLING_MODE = BUFFERED` | Fog of War của VALORANT ở dạng triển khai cuối |
| NPC màu vàng (rò do buffer) | Bề mặt tấn công còn lại sau khi đã cull |

### Nguồn tham khảo

Sắp xếp theo mức độ ưu tiên trích dẫn. Ưu tiên tuyệt đối cho nguồn gốc (blog kỹ thuật của Riot) hơn là bài báo thứ cấp.

**Nguồn gốc — bắt buộc đọc:**
- Riot Games Technology — *Demolishing Wallhacks with VALORANT's Fog of War*: https://technology.riotgames.com/news/demolishing-wallhacks-valorants-fog-war
- Riot Games Technology — *Peeking into VALORANT's Netcode*: https://technology.riotgames.com/news/peeking-valorants-netcode

**Triển khai mã nguồn mở để đối chiếu:**
- CornerCulling — server-side occlusion culling cho CS:GO, dùng analytical raycast + cache occluder + BVH: https://github.com/87andrewh/CornerCulling
  Đây là nguồn quý cho phần benchmark: họ đã đo hiệu năng và xử lý bài toán độ trễ. Có thể so sánh kết quả sandbox của bạn với con số của họ.

**Diễn biến 2026 — cho phần thảo luận:**
- Vanguard On-Demand và TPM attestation: https://windowsnews.ai/article/riot-games-ends-always-on-kernel-anti-cheat-with-vanguard-on-demand-for-windows-11.431019

**Lưu ý về nguồn:** khi tìm tài liệu về Vanguard, phần lớn kết quả tìm kiếm đến từ các trang bán cheat. Không trích dẫn những nguồn đó trong báo cáo học thuật — chúng thiên lệch và không kiểm chứng được. Ưu tiên blog kỹ thuật của nhà phát hành, tài liệu Microsoft về VBS/HVCI/TPM attestation, và các bài báo hội nghị về game security.

### Gợi ý mở rộng cho phần thảo luận

Nếu muốn nhắm tới chuẩn công bố mà slide cuối của môn đề cập, ba câu hỏi sau có thể định lượng được bằng chính sandbox này và chưa được khảo sát nhiều:

1. **Quan hệ giữa độ rộng buffer và lợi thế của cheat.** Quét buffer từ 0 đến 500ms, đo lượng thông tin rò rỉ (số tick, khoảng cách tới thời điểm lộ diện). Vẽ đường cong đánh đổi giữa chất lượng trải nghiệm và bề mặt tấn công.
2. **Ngưỡng phát hiện của timing analysis.** Với overhead bao nhiêu ms thì challenge–response phát hiện được cheat ở độ tin cậy 95%? Đường biên này có ý nghĩa thực tiễn.
3. **Chi phí tính toán của culling theo số người chơi.** Đo thời gian mỗi tick khi N tăng, so sánh raycast thuần với có cache occluder — đối chiếu với hướng tiếp cận của CornerCulling.

---

## Ràng buộc phạm vi (giữ nguyên khi đưa cho AI)

- Chỉ thao tác trên đối tượng do chính dự án tạo ra
- Không dùng, không mô tả kỹ thuật né tránh anti-cheat thương mại
- Không có phần nào của code chạy được ngoài sandbox này
- Comment trong code phải nêu rõ đây là mô phỏng giáo dục
