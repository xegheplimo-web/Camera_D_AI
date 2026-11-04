Camera D-AI — Hostile Review vòng 3

Baseline: main @ 6674da3
Đánh giá: Đã đối chiếu mã nguồn GitHub và tài liệu MediaMTX 1.21.3/PostgreSQL. Không coi các số liệu runtime do Hermes cung cấp là kết quả tôi tự chạy.

1. Phán quyết C1–C5

Claim

	

Verdict

	

Lý do quyết định




C1 — MediaMTX authentication

	

MODIFY

	

Lộ quyền read/publish/playback cho LAN là vấn đề P0. Nhưng 11,53 GB/ngày là tổng lượng ghi, không phải mỗi path; chưa chứng minh được publish vào path chưa đăng ký.




C2 — Superuser + RLS

	

KEEP

	

0 policy và runtime superuser khiến RLS không bảo vệ được dữ liệu. Phải tách runtime credential khỏi migration credential trước khi triển khai RLS.




C3 — Sonar không ưu tiên

	

MODIFY

	

Không cần xử lý 409 code smell hàng loạt, nhưng không được bỏ qua complexity tại code security-critical chỉ vì duplication thấp.




C4 — Audit attribution

	

MODIFY

	

Thiếu attribution là lỗi thật; tuy nhiên không thể kết luận mọi security control đều không kiểm chứng được. Có lỗi nghiêm trọng hơn: audit có thể ghi sai danh tính.




C5 — PostgreSQL durability

	

MODIFY

	

Ba lần shutdown không sạch và restart=no chứng minh vấn đề phục hồi, nhưng chưa chứng minh corruption hoặc mất dữ liệu thực tế.

C1 — MODIFY

Điểm Hermes chưa chứng minh: có quyền publish mọi path không đồng nghĩa mọi tên path đều được cấu hình hợp lệ. Cấu hình paths và runtime-created paths vẫn quyết định path tồn tại.

Ngoài ra, file cũ nhất mới 34,3 giờ: phép đo 0 file >168h không chứng minh retention đã xóa thành công.

MediaMTX xác nhận any cho phép anonymous access, path="" không hạn chế path theo quyền, và maxReaders=0 là không giới hạn. 
MediaMTX

Giữ P0 vì nguy cơ xem trộm luồng camera, không phải vì đã chứng minh đầy đĩa.

C2 — KEEP

Tại src/db/index.ts:14–24, ứng dụng dùng shared PostgreSQL pool. drizzle.config.ts:3–4 dùng cùng DATABASE_URL cho migration.

Đổi credential trực tiếp có thể làm gãy drizzle-kit push.

Cần MIGRATION_DATABASE_URL riêng và kiểm thử quyền runtime trước khi bật policy. Superuser luôn vượt RLS theo cơ chế PostgreSQL. 
postgresql.org

C3 — MODIFY

Tỷ lệ duplication 0,4% chỉ chứng minh duplication thấp, không chứng minh cognitive complexity vô hại.

12 BUG: phân loại theo khả năng gây lỗi runtime.

16 VULNERABILITY: sửa workflow supply-chain, kiểm chứng bằng CI.

409 CODE_SMELL: không sửa hàng loạt; chỉ xử lý phần liên quan security/media và code vừa thay đổi.

Không chấp nhận quyết định IGNORE toàn bộ 409 issue vĩnh viễn.

C4 — MODIFY

Đã xác minh lỗi cụ thể:

auth/login/route.ts:71–74: audit trước khi gắn cookie đăng nhập mới.

lib/audit.ts:9–13: lấy actor/tenant từ cookie request hiện tại.

lib/audit.ts:21–23: nuốt toàn bộ exception.

Hệ quả: đăng nhập tài khoản B khi còn cookie A có thể ghi log dưới danh tính A.

/api/admin/route.ts:35–36 đã lọc bằng auditLog.tenantId, không phải tên hiển thị. Do đó, vấn đề hiện tại là attribution sai hoặc thiếu, chưa có bằng chứng admin API đang đọc xuyên tenant.

C5 — MODIFY

PostgreSQL WAL recovery cho phép phục hồi sau shutdown không sạch; ba lần recovery không tự chứng minh mất dữ liệu.

Nhưng restart=no nghĩa là tiến trình container không tự được Docker khởi động lại sau crash theo restart policy.

Cần xác định nguyên nhân container dừng và kiểm thử khởi động lại trên cả Docker lẫn Windows host. Chỉ thêm restart: unless-stopped không giải quyết được Docker Desktop không chạy.

2. Ba việc phải làm đầu tiên

Thứ tự

	

Công việc và phạm vi sửa

	

Mức độ / chi phí ước tính

	

Điều kiện nghiệm thu




FIRST

	

Khóa quyền MediaMTX: cấu hình auth, publish/read/playback/API và pathDefaults.record

	

P0 trực tiếp; khoảng 1–3 giờ nếu không có dependency ẩn

	

LAN không credential không đọc/publish được; camera 796 vẫn hoạt động




SECOND

	

Sửa khả năng tự phục hồi PostgreSQL trong cấu hình Docker triển khai thật, điều tra nguyên nhân shutdown

	

P0 availability; khoảng 1–3 giờ cho guard và phép thử ban đầu

	

DB tự phục hồi ≤60 giây sau lỗi container trong môi trường test




THIRD

	

Tách app_rw/migrator, triển khai RLS và negative tests cho tenant

	

P0 data isolation; 1–3 ngày công là ước lượng, chưa đo

	

NOSUPERUSER, NOBYPASSRLS; 0 cross-tenant success

FIRST — MediaMTX authentication

Severity × exploitability: cao nhất vì đang có quyền anonymous cho các nguồn trong LAN. Không cần tìm lỗi SQL hay vượt qua lớp xác thực Next.js để thử đọc RTSP trực tiếp.

Thay đổi:

Đưa cấu hình bảo mật MediaMTX thành deployment template được quản lý trong repo; runtime/mediamtx/mediamtx.yml hiện chưa xác minh là file được Git quản lý.

Mặc định record: false, chỉ path recording hợp lệ mới bật.

Tách credential publisher, reader và administrator; API chỉ cấp cho thành phần cần thiết.

Kiểm tra src/lib/camera/recorder.ts khi tạo path động, bảo đảm không tái mở quyền toàn cục.

Không tắt anonymous permission đột ngột trên pipeline thật trước khi kiểm tra go2rtc, FFmpeg và EZVIZ đang dùng credential nào.

SECOND — PostgreSQL durability

Ba lần unclean shutdown trong 24 giờ là bằng chứng đủ mạnh để ưu tiên phục hồi dịch vụ, dù nguyên nhân chưa xác định.

Thay đổi cấu hình triển khai PostgreSQL thật:

YAML
restart: unless-stopped
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U postgres -d app_db"]
  interval: 10s
  timeout: 5s
  retries: 5

Đồng thời kiểm tra container volume, Docker Desktop và Windows Event Log. Không sửa docker-compose.test.yml rồi tuyên bố đã bảo vệ production nếu production sử dụng Compose khác.

THIRD — Database isolation

Tôi giữ hướng app_rw → RLS, nhưng bổ sung một điều kiện bắt buộc: migration phải dùng tài khoản riêng.

Thay đổi:

src/db/index.ts: runtime chỉ dùng DATABASE_URL của app_rw.

drizzle.config.ts: ưu tiên MIGRATION_DATABASE_URL, không để runtime vô tình thực hiện migration.

CI/deploy: truyền migration credential riêng, không đưa vào tiến trình Next.js.

RLS: triển khai transaction-scoped tenant context và negative tests, xử lý riêng login/bootstrap/worker.

Không coi việc tạo role là hoàn thành isolation khi RLS vẫn bằng 0.

3. Failure mode bằng chứng Hermes chưa phủ

Khoảng trống

	

Vì sao nguy hiểm




Deployment drift

	

Cấu hình MediaMTX runtime không chắc trùng với file được Git quản lý. PR xanh nhưng quyền live không đổi.




Anonymous read thực tế

	

Auth config cho phép truy cập, nhưng chưa có thử nghiệm từ máy LAN không credential.




Tồn tại path ngoài cấu hình

	

permissions.path="" cho phép xét quyền trên mọi path, không chứng minh MediaMTX chấp nhận mọi path chưa đăng ký.




Retention thật

	

File cũ nhất 34,3 giờ, ngưỡng 168 giờ; chưa thể nói bộ dọn dẹp đã chạy thành công.




PostgreSQL bị dừng bởi host

	

Restart policy không xử lý được mất Docker Desktop, mất nguồn máy hoặc lỗi volume.




RLS và dữ liệu phi SQL

	

RLS không bảo vệ trực tiếp file video, redirect URL, stream hoặc filesystem.




Audit identity contamination

	

Cookie A đăng nhập B có thể ghi actor A, khiến sự kiện bị gắn sang tenant sai thay vì chỉ NULL.

Failure mode có khả năng đảo ngược toàn bộ ranking: MediaMTX thực tế bị firewall chặn đối với mọi thiết bị không tin cậy, trong khi Next.js có một đường HTTP cho phép truy cập xuyên tenant từ Internet.

Nếu negative test chứng minh tình huống đó, database isolation phải vượt MediaMTX lên FIRST.

Hiện chưa có phép đo xác nhận tình huống này.

4. Phép thử rẻ nhất để phân xử từng claim

Claim

	

Lệnh / kiểm thử

	

Kết quả dự đoán trên baseline




C1

	

ffprobe -v error -rtsp_transport tcp rtsp://192.168.1.243:8554/cam từ máy LAN khác, không credential

	

Đọc được nếu path cam đang online và firewall cho phép




C2

	

SQL kiểm tra role (bên dưới)

	

app_rw chưa tồn tại




C3

	

curl -s 'https://sonarcloud.io/api/issues/search?componentKeys=xegheplimo-web_Camera_D_AI&types=BUG&ps=100'

	

Trả danh sách 12 BUG theo dữ liệu Hermes




C4

	

SQL lấy các audit login mới nhất (bên dưới)

	

Phần lớn tenant/actor NULL




C5

	

docker inspect camdai-pg --format '{{.HostConfig.RestartPolicy.Name}} {{.State.OOMKilled}} {{.RestartCount}}'

	

no, OOMKilled cần kiểm tra, RestartCount=0

C2 — kiểm tra role:

Bash
docker exec camdai-pg psql -U postgres -d app_db -Atc \
"SELECT rolname,rolsuper,rolbypassrls
 FROM pg_roles WHERE rolname='app_rw';"

Sau khi tạo role và RLS, bài kiểm thử quyết định phải chạy trên database thử nghiệm bằng chính app_rw: tenant A đọc A thành công, không đọc/ghi B, thiếu context không truy cập dữ liệu tenant, và không lẫn context giữa các pooled connection.

C4 — kiểm tra audit:

Bash
docker exec camdai-pg psql -U postgres -d app_db -c \
"SELECT tenant_id,actor,target_id
 FROM audit_log
 WHERE action='auth.login'
 ORDER BY id DESC LIMIT 10;"

Sau đó bổ sung test mới tests/h01g-login-attribution.test.ts: đăng nhập B không có cookie và đăng nhập B với cookie A đều phải ghi actor/tenant B. Chỉ dùng identity từ tài khoản vừa xác thực, không lấy từ cookie trước đăng nhập.

C1 cần thêm negative test: thử publish vào path thử nghiệm chưa khai báo trên MediaMTX test instance, không dùng path cam production. Dự đoán bị từ chối nếu không có all_others hoặc path động tương ứng; kết quả này phải đo, không suy từ permission.

C5 cần fault injection: trên container PostgreSQL thử nghiệm, dùng docker kill --signal=KILL <test-container> rồi kiểm tra health/restart. Không chạy phép thử phá hủy trên camdai-pg đang chứa dữ liệu thật.

Tiêu chuẩn PASS sau sửa

Claim

	

PASS khi




C1

	

0 anonymous read/publish thành công; API không truy cập từ LAN; camera 796 tiếp tục streaming/recording




C2

	

Runtime không dùng superuser; 0 bypass RLS trên negative suite




C3

	

0 BUG runtime chưa phân loại; 0 workflow vulnerability mới; PR gate xanh




C4

	

100% login thành công mới có đúng actor và tenant; lỗi ghi audit nhạy cảm được phát hiện




C5

	

Recovery ≤60 giây trong fault test; không lỗi dữ liệu; ứng dụng tự kết nối lại

5. Phản biện mạnh nhất với chính ranking của tôi

Điểm yếu nhất: tôi xếp MediaMTX lên đầu dựa trên quyền truy cập được cấu hình, chưa có bằng chứng HTTP/RTSP unauthenticated access thành công từ một thiết bị LAN độc lập.

Trong khi đó, database runtime superuser và RLS=0 đã được chứng minh trực tiếp. Về mặt phạm vi thiệt hại, nếu có lỗi truy vấn hoặc phân quyền ở API, toàn bộ dữ liệu tenant đều có nguy cơ bị tác động.

Đây là lập luận mạnh để đưa database isolation lên đầu.

Có thay đổi verdict không?

Chưa. Vì MediaMTX có đường truy cập mạng trực tiếp, remediation nhỏ và có thể đo độc lập với database. Tôi vẫn chọn FIRST cho MediaMTX, nhưng đặt điều kiện:

Nếu anonymous read thành công: giữ FIRST, xác nhận P0.

Nếu firewall và auth thực tế chặn mọi truy cập trái phép từ vùng không tin cậy: hạ ưu tiên MediaMTX và chuyển least-privilege/RLS lên FIRST.

Nếu hardening làm camera 796 mất kết nối: rollback cấu hình canary, sửa credential integration trước khi triển khai lại.

6. Kết luận để Hermes phản biện

Ranking cuối cùng:

1

MediaMTX: khóa quyền đọc và publish trực tiếp

2

PostgreSQL: tự phục hồi và điều tra crash

3

PostgreSQL: app_rw + migration separation + RLS

Sau ba mục này, ưu tiên lần lượt: sửa audit identity contamination, backup/restore, recording quota, giới hạn consumer, soak 72 giờ, xử lý 12 BUG/16 workflow findings, rồi refactor có chọn lọc.

Hai lỗi lập luận quan trọng nhất của Hermes cần sửa trong tài liệu:

0 file già hơn 168h khi file cũ nhất mới 34,3 giờ không chứng minh retention hoạt động.

11,53 GB ghi trong 24h trên toàn bộ recording không phải 11,53 GB/ngày cho mỗi path.

Đây là hai chỗ cần loại bỏ suy luận vượt quá bằng chứng, ngay cả khi hướng ưu tiên bảo mật MediaMTX vẫn đúng.