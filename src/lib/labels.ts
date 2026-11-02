export const VI_LABELS: Record<string, string> = {
  person: "người", bicycle: "xe đạp", car: "ô tô", motorcycle: "xe máy", bus: "xe buýt", truck: "xe tải",
  "traffic light": "đèn giao thông", "stop sign": "biển dừng", bench: "ghế dài", bird: "chim", cat: "mèo", dog: "chó",
  backpack: "ba lô", umbrella: "ô/dù", handbag: "túi xách", tie: "cà vạt", suitcase: "vali", bottle: "chai",
  "wine glass": "ly", cup: "cốc", fork: "nĩa", knife: "dao", spoon: "thìa", bowl: "bát", banana: "chuối", apple: "táo",
  orange: "cam", chair: "ghế", couch: "sofa", "potted plant": "chậu cây", bed: "giường", "dining table": "bàn",
  toilet: "bồn cầu", tv: "màn hình/TV", laptop: "laptop", mouse: "chuột", remote: "điều khiển", keyboard: "bàn phím",
  "cell phone": "điện thoại", microwave: "lò vi sóng", oven: "lò nướng", sink: "bồn rửa", refrigerator: "tủ lạnh",
  book: "sách", clock: "đồng hồ", vase: "bình hoa", scissors: "kéo", "teddy bear": "gấu bông", "hair drier": "máy sấy",
  toothbrush: "bàn chải", "sports ball": "bóng", kite: "diều", skateboard: "ván trượt", "fire hydrant": "trụ cứu hỏa",
  "parking meter": "đồng hồ đỗ xe", horse: "ngựa", cow: "bò", sheep: "cừu", elephant: "voi", bear: "gấu", zebra: "ngựa vằn",
  giraffe: "hươu cao cổ", frisbee: "đĩa bay", skis: "ván trượt tuyết", snowboard: "ván tuyết", "baseball bat": "gậy bóng chày",
  "baseball glove": "găng bóng chày", surfboard: "ván lướt", "tennis racket": "vợt tennis", sandwich: "bánh mì kẹp",
  broccoli: "bông cải", carrot: "cà rốt", "hot dog": "xúc xích", pizza: "pizza", donut: "bánh donut", cake: "bánh ngọt",
  boat: "thuyền", train: "tàu hỏa", airplane: "máy bay", toaster: "máy nướng bánh",
};

export const vi = (l: string) => VI_LABELS[l] ?? l;

export const EVENT_TYPES: Record<string, { label: string; color: string }> = {
  person_in: { label: "Khách vào", color: "emerald" },
  person_out: { label: "Khách ra", color: "sky" },
  vehicle: { label: "Phương tiện", color: "rose" },
  motion: { label: "Hoạt động", color: "indigo" },
  alert: { label: "Cảnh báo", color: "orange" },
  snapshot: { label: "Ảnh chụp", color: "cyan" },
  manual: { label: "Thủ công", color: "violet" },
  clip: { label: "Clip", color: "fuchsia" },
  extraction: { label: "Trích xuất", color: "teal" },
};
