// 界面多语言（i18n）
//
// 为什么不用 Chrome 原生的 _locales：原生方案只能跟随**浏览器语言**自动选，用户没法在
// 设置里手动切换。这里做的是运行时切换：设置项 language 变化后，界面文字立刻重渲染。
//
// 覆盖范围：**界面主干**（标题、标签、按钮、选项、输入框提示）。
// 长说明段落（各设置项下面的灰色解释）暂时保留中文 —— 会在后续版本补齐，
// 设置页里也会明确告诉用户"部分详细说明仍是中文"。
//
// 缺失的词条按「目标语言 → 英文 → 中文」的顺序回退，所以某个语言漏翻译不会出现空白。

export const LANGUAGES = [
  { code: 'zh', label: '简体中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'vi', label: 'Tiếng Việt' }
];

const ZH = {
  appName: '雅思助手',

  // 通用按钮
  btnSave: '保存设置',
  btnClear: '清空',
  btnCopy: '复制',
  btnClose: '关闭',
  btnShow: '显示',
  btnHide: '隐藏',
  btnAdd: '添加',
  btnDelete: '删除',
  btnImport: '导入',
  btnTest: '测试连接',

  // 侧边栏
  tabReading: '阅读',
  tabListening: '听力',
  tabWriting: '写作思路',
  tabReview: '作文批改',
  tabChat: '划词精讲',
  labelQuestionSource: '题目出处（手动指定）',
  placeholderQuestionSource: '例如 Cambridge 18 Test 2 Passage 1',
  labelPassage: '阅读原文',
  labelQuestion: '题目 / 文章',
  placeholderPassage: '把雅思阅读文章粘到这里（可留空）',
  placeholderQuestion: '在网页上划选题目 → 点「用选中文字」，或点「抓取本页」',
  labelImage: '图表 / 图片（小作文用）',
  labelTask: '题型',
  task1: 'Task 1 小作文',
  task2: 'Task 2 大作文',
  btnGrabPage: '抓取本页',
  btnUseSelection: '用选中文字',
  btnUploadImage: '上传图片',
  btnCaptureTab: '截取当前画面',
  btnGrabImages: '抓取本页图片',
  btnRun: '开始分析',
  btnStop: '停止生成',
  labelBrief: '简洁',
  resultTitle: '分析结果',
  btnExpand: '放大',
  btnSearchAnswer: '搜答案核对',
  resultEmpty: '分析结果会显示在这里。',
  bannerNoKey: '还没有配置 DeepSeek API Key。',
  btnGoFill: '去填写',
  btnGoSettings: '去设置',
  settingsTitle: '打开设置',

  // 气泡
  bubbleTranslate: '翻译',
  bubbleExplain: '深入精讲',
  bubbleCopy: '复制译文',
  bubbleAiTranslate: 'AI 精译',
  bubbleCopied: '已复制',

  // 设置页
  optTitle: '雅思助手 · 设置',
  optSub: '填好 API Key 就能用。设置只存在你本机。',
  secApi: 'DeepSeek 接口',
  labelApiKey: 'API Key',
  labelBaseUrl: '接口地址',
  labelModel: '模型',
  labelTemperature: '温度',
  labelLanguage: '界面语言',
  secPrefs: '做题偏好',
  optTargetBand: '目标分数',
  optExplainLang: '讲解语言',
  optTranslateEngine: '翻译方式（划词翻译用）',
  labelManualSource: '手动指定题目出处',
  labelSmartSplit: '抓取本页时用 AI 判断原文 / 题目',
  labelBubble: '划选后显示「译」气泡',
  labelAutoTranslate: '划选后自动翻译',
  labelOpacity: '气泡透明度',
  labelCopyFormat: '点气泡里译文旁的 📋 复制什么',
  labelStream: '流式输出：边生成边显示',
  labelWebSearch: '分析前先联网核对题目出处',
  labelWebSearchEngine: '联网检索方式',
  labelMaxTokens: '单次回复上限（tokens）',
  secHowto: '怎么用',
  secGlossary: '术语库',
  secLearning: '词汇学习',
  copyZh: '只要中文译文',
  copyEn: '只要英文原文',
  copyBoth: '英文原文 + 中文译文',
  langNote: '界面主干已支持这 5 种语言；部分详细说明仍是中文，会在后续版本继续补齐。'
};

const EN = {
  appName: 'IELTS Copilot',

  btnSave: 'Save settings',
  btnClear: 'Clear',
  btnCopy: 'Copy',
  btnClose: 'Close',
  btnShow: 'Show',
  btnHide: 'Hide',
  btnAdd: 'Add',
  btnDelete: 'Delete',
  btnImport: 'Import',
  btnTest: 'Test connection',

  tabReading: 'Reading',
  tabListening: 'Listening',
  tabWriting: 'Writing',
  tabReview: 'Review',
  tabChat: 'Explain',
  labelQuestionSource: 'Source (manual)',
  placeholderQuestionSource: 'e.g. Cambridge 18 Test 2 Passage 1',
  labelPassage: 'Passage',
  labelQuestion: 'Questions / Text',
  placeholderPassage: 'Paste the reading passage here (optional)',
  placeholderQuestion: 'Select questions on the page → "Use selection", or click "Grab page"',
  labelImage: 'Chart / Image (Task 1)',
  labelTask: 'Task',
  task1: 'Task 1',
  task2: 'Task 2',
  btnGrabPage: 'Grab page',
  btnUseSelection: 'Use selection',
  btnUploadImage: 'Upload',
  btnCaptureTab: 'Capture screen',
  btnGrabImages: 'Grab images',
  btnRun: 'Analyse',
  btnStop: 'Stop',
  labelBrief: 'Brief',
  resultTitle: 'Result',
  btnExpand: 'Expand',
  btnSearchAnswer: 'Check online',
  resultEmpty: 'The analysis will appear here.',
  bannerNoKey: 'No DeepSeek API Key configured yet.',
  btnGoFill: 'Add key',
  btnGoSettings: 'Settings',
  settingsTitle: 'Open settings',

  bubbleTranslate: 'Translate',
  bubbleExplain: 'Explain',
  bubbleCopy: 'Copy translation',
  bubbleAiTranslate: 'AI translation',
  bubbleCopied: 'Copied',

  optTitle: 'IELTS Copilot · Settings',
  optSub: 'Just add your API key. Settings stay on your machine.',
  secApi: 'DeepSeek API',
  labelApiKey: 'API Key',
  labelBaseUrl: 'Base URL',
  labelModel: 'Model',
  labelTemperature: 'Temperature',
  labelLanguage: 'Language',
  secPrefs: 'Preferences',
  optTargetBand: 'Target band',
  optExplainLang: 'Explanation language',
  optTranslateEngine: 'Translation mode (for word lookup)',
  labelManualSource: 'Specify question source manually',
  labelSmartSplit: 'Use AI to split passage / questions when grabbing',
  labelBubble: 'Show translate bubble after selecting text',
  labelAutoTranslate: 'Translate automatically after selecting',
  labelOpacity: 'Bubble opacity',
  labelCopyFormat: 'What 📋 copies in the bubble',
  labelStream: 'Stream output as it generates',
  labelWebSearch: 'Search online for the question source first',
  labelWebSearchEngine: 'Search engine',
  labelMaxTokens: 'Max reply tokens',
  secHowto: 'How to use',
  secGlossary: 'Glossary',
  secLearning: 'Vocabulary learning',
  copyZh: 'Chinese translation only',
  copyEn: 'English original only',
  copyBoth: 'English + Chinese',
  langNote: 'Main interface supports these 5 languages; some detailed notes are still in Chinese and will be translated in later versions.'
};

const JA = {
  appName: 'IELTS Copilot',

  btnSave: '設定を保存',
  btnClear: 'クリア',
  btnCopy: 'コピー',
  btnClose: '閉じる',
  btnShow: '表示',
  btnHide: '隠す',
  btnAdd: '追加',
  btnDelete: '削除',
  btnImport: 'インポート',
  btnTest: '接続テスト',

  tabReading: 'リーディング',
  tabListening: 'リスニング',
  tabWriting: 'ライティング',
  tabReview: '添削',
  tabChat: '解説',
  labelQuestionSource: '出典（手動指定）',
  placeholderQuestionSource: '例：Cambridge 18 Test 2 Passage 1',
  labelPassage: '本文',
  labelQuestion: '問題 / テキスト',
  placeholderPassage: 'リーディング本文を貼り付け（空欄可）',
  placeholderQuestion: 'ページ上で問題を選択 →「選択範囲を使用」、または「ページを取得」',
  labelImage: 'グラフ / 画像（Task 1）',
  labelTask: 'タスク',
  task1: 'Task 1',
  task2: 'Task 2',
  btnGrabPage: 'ページを取得',
  btnUseSelection: '選択範囲を使用',
  btnUploadImage: '画像を選択',
  btnCaptureTab: '画面を撮影',
  btnGrabImages: '画像を取得',
  btnRun: '分析する',
  btnStop: '停止',
  labelBrief: '簡潔',
  resultTitle: '分析結果',
  btnExpand: '拡大',
  btnSearchAnswer: '答えを照合',
  resultEmpty: '分析結果がここに表示されます。',
  bannerNoKey: 'DeepSeek API Key が未設定です。',
  btnGoFill: '設定する',
  btnGoSettings: '設定',
  settingsTitle: '設定を開く',

  bubbleTranslate: '翻訳',
  bubbleExplain: '詳しく解説',
  bubbleCopy: '訳文をコピー',
  bubbleAiTranslate: 'AI 翻訳',
  bubbleCopied: 'コピーしました',

  optTitle: 'IELTS Copilot · 設定',
  optSub: 'API Key を入れるだけで使えます。設定は端末内にのみ保存されます。',
  secApi: 'DeepSeek API',
  labelApiKey: 'API Key',
  labelBaseUrl: 'ベース URL',
  labelModel: 'モデル',
  labelTemperature: '温度',
  labelLanguage: '表示言語',
  secPrefs: '学習設定',
  optTargetBand: '目標スコア',
  optExplainLang: '解説の言語',
  optTranslateEngine: '翻訳方式（単語検索用）',
  labelManualSource: '出典を手動で指定',
  labelSmartSplit: '取得時に AI で本文 / 問題を判定',
  labelBubble: 'テキスト選択後に翻訳バブルを表示',
  labelAutoTranslate: '選択後すぐに翻訳する',
  labelOpacity: 'バブルの透明度',
  labelCopyFormat: 'バブル内の 📋 でコピーする内容',
  labelStream: '生成しながら表示',
  labelWebSearch: '分析前に出典をネット検索',
  labelWebSearchEngine: '検索方法',
  labelMaxTokens: '最大トークン数',
  secHowto: '使い方',
  secGlossary: '用語集',
  secLearning: '語彙学習',
  copyZh: '中国語訳のみ',
  copyEn: '英語原文のみ',
  copyBoth: '英語原文 + 中国語訳',
  langNote: '主要な画面はこの 5 言語に対応しています。一部の詳細説明は中国語のままで、今後のバージョンで対応します。'
};

const KO = {
  appName: 'IELTS Copilot',

  btnSave: '설정 저장',
  btnClear: '지우기',
  btnCopy: '복사',
  btnClose: '닫기',
  btnShow: '표시',
  btnHide: '숨기기',
  btnAdd: '추가',
  btnDelete: '삭제',
  btnImport: '가져오기',
  btnTest: '연결 테스트',

  tabReading: '리딩',
  tabListening: '리스닝',
  tabWriting: '라이팅',
  tabReview: '첨삭',
  tabChat: '해설',
  labelQuestionSource: '출처(직접 지정)',
  placeholderQuestionSource: '예: Cambridge 18 Test 2 Passage 1',
  labelPassage: '본문',
  labelQuestion: '문제 / 텍스트',
  placeholderPassage: '리딩 본문을 붙여넣으세요(비워도 됨)',
  placeholderQuestion: '페이지에서 문제를 선택 → "선택 영역 사용", 또는 "페이지 가져오기"',
  labelImage: '그래프 / 이미지 (Task 1)',
  labelTask: '과제',
  task1: 'Task 1',
  task2: 'Task 2',
  btnGrabPage: '페이지 가져오기',
  btnUseSelection: '선택 영역 사용',
  btnUploadImage: '이미지 선택',
  btnCaptureTab: '화면 캡처',
  btnGrabImages: '이미지 가져오기',
  btnRun: '분석하기',
  btnStop: '중지',
  labelBrief: '간단히',
  resultTitle: '분석 결과',
  btnExpand: '확대',
  btnSearchAnswer: '정답 확인',
  resultEmpty: '분석 결과가 여기에 표시됩니다.',
  bannerNoKey: 'DeepSeek API Key 가 설정되지 않았습니다.',
  btnGoFill: '입력하기',
  btnGoSettings: '설정',
  settingsTitle: '설정 열기',

  bubbleTranslate: '번역',
  bubbleExplain: '자세히 해설',
  bubbleCopy: '번역 복사',
  bubbleAiTranslate: 'AI 번역',
  bubbleCopied: '복사됨',

  optTitle: 'IELTS Copilot · 설정',
  optSub: 'API Key 만 입력하면 됩니다. 설정은 이 기기에만 저장됩니다.',
  secApi: 'DeepSeek API',
  labelApiKey: 'API Key',
  labelBaseUrl: '기본 URL',
  labelModel: '모델',
  labelTemperature: '온도',
  labelLanguage: '인터페이스 언어',
  secPrefs: '학습 설정',
  optTargetBand: '목표 점수',
  optExplainLang: '해설 언어',
  optTranslateEngine: '번역 방식(단어 조회용)',
  labelManualSource: '출처 직접 지정',
  labelSmartSplit: '가져올 때 AI 로 본문 / 문제 구분',
  labelBubble: '텍스트 선택 시 번역 버블 표시',
  labelAutoTranslate: '선택 후 자동 번역',
  labelOpacity: '버블 불투명도',
  labelCopyFormat: '버블의 📋 로 복사할 내용',
  labelStream: '생성되는 대로 표시',
  labelWebSearch: '분석 전에 출처를 인터넷 검색',
  labelWebSearchEngine: '검색 방식',
  labelMaxTokens: '최대 토큰 수',
  secHowto: '사용법',
  secGlossary: '용어집',
  secLearning: '어휘 학습',
  copyZh: '중국어 번역만',
  copyEn: '영어 원문만',
  copyBoth: '영어 원문 + 중국어 번역',
  langNote: '주요 화면은 이 5개 언어를 지원합니다. 일부 상세 설명은 아직 중국어이며 이후 버전에서 지원됩니다.'
};

const VI = {
  appName: 'IELTS Copilot',

  btnSave: 'Lưu cài đặt',
  btnClear: 'Xoá',
  btnCopy: 'Sao chép',
  btnClose: 'Đóng',
  btnShow: 'Hiện',
  btnHide: 'Ẩn',
  btnAdd: 'Thêm',
  btnDelete: 'Xoá',
  btnImport: 'Nhập',
  btnTest: 'Kiểm tra kết nối',

  tabReading: 'Đọc',
  tabListening: 'Nghe',
  tabWriting: 'Viết',
  tabReview: 'Chấm bài',
  tabChat: 'Giải thích',
  labelQuestionSource: 'Nguồn đề (nhập tay)',
  placeholderQuestionSource: 'VD: Cambridge 18 Test 2 Passage 1',
  labelPassage: 'Bài đọc',
  labelQuestion: 'Câu hỏi / Văn bản',
  placeholderPassage: 'Dán bài đọc vào đây (có thể để trống)',
  placeholderQuestion: 'Chọn câu hỏi trên trang → "Dùng phần đã chọn", hoặc "Lấy trang"',
  labelImage: 'Biểu đồ / Ảnh (Task 1)',
  labelTask: 'Dạng bài',
  task1: 'Task 1',
  task2: 'Task 2',
  btnGrabPage: 'Lấy trang',
  btnUseSelection: 'Dùng phần đã chọn',
  btnUploadImage: 'Tải ảnh',
  btnCaptureTab: 'Chụp màn hình',
  btnGrabImages: 'Lấy ảnh trong trang',
  btnRun: 'Phân tích',
  btnStop: 'Dừng',
  labelBrief: 'Ngắn gọn',
  resultTitle: 'Kết quả phân tích',
  btnExpand: 'Mở rộng',
  btnSearchAnswer: 'Đối chiếu đáp án',
  resultEmpty: 'Kết quả phân tích sẽ hiện ở đây.',
  bannerNoKey: 'Chưa cấu hình DeepSeek API Key.',
  btnGoFill: 'Nhập ngay',
  btnGoSettings: 'Cài đặt',
  settingsTitle: 'Mở cài đặt',

  bubbleTranslate: 'Dịch',
  bubbleExplain: 'Giải thích chi tiết',
  bubbleCopy: 'Sao chép bản dịch',
  bubbleAiTranslate: 'Dịch bằng AI',
  bubbleCopied: 'Đã sao chép',

  optTitle: 'IELTS Copilot · Cài đặt',
  optSub: 'Chỉ cần nhập API Key. Cài đặt chỉ lưu trên máy bạn.',
  secApi: 'DeepSeek API',
  labelApiKey: 'API Key',
  labelBaseUrl: 'Địa chỉ API',
  labelModel: 'Mô hình',
  labelTemperature: 'Độ sáng tạo',
  labelLanguage: 'Ngôn ngữ giao diện',
  secPrefs: 'Tuỳ chọn học tập',
  optTargetBand: 'Điểm mục tiêu',
  optExplainLang: 'Ngôn ngữ giải thích',
  optTranslateEngine: 'Cách dịch (khi tra từ)',
  labelManualSource: 'Tự nhập nguồn đề',
  labelSmartSplit: 'Dùng AI phân biệt bài đọc / câu hỏi khi lấy trang',
  labelBubble: 'Hiện bong bóng dịch khi bôi đen',
  labelAutoTranslate: 'Tự động dịch sau khi bôi đen',
  labelOpacity: 'Độ trong suốt của bong bóng',
  labelCopyFormat: 'Nút 📋 trong bong bóng sao chép gì',
  labelStream: 'Hiện dần khi đang tạo',
  labelWebSearch: 'Tìm nguồn đề trên mạng trước khi phân tích',
  labelWebSearchEngine: 'Cách tìm kiếm',
  labelMaxTokens: 'Giới hạn token mỗi lần trả lời',
  secHowto: 'Cách dùng',
  secGlossary: 'Thuật ngữ',
  secLearning: 'Học từ vựng',
  copyZh: 'Chỉ bản dịch tiếng Trung',
  copyEn: 'Chỉ nguyên văn tiếng Anh',
  copyBoth: 'Tiếng Anh + tiếng Trung',
  langNote: 'Giao diện chính đã hỗ trợ 5 ngôn ngữ này; một số mô tả chi tiết vẫn là tiếng Trung và sẽ được dịch trong các bản sau.'
};

const MESSAGES = { zh: ZH, en: EN, ja: JA, ko: KO, vi: VI };

const SUPPORTED = LANGUAGES.map((item) => item.code);

/** 把任意输入规范成一个受支持的语言代码 */
export function normalizeLang(value) {
  const code = String(value || '').toLowerCase().slice(0, 2);
  return SUPPORTED.includes(code) ? code : 'zh';
}

/**
 * 取一条界面文字。
 * 回退顺序：目标语言 → 英文 → 中文 → 返回 key 本身（便于发现漏配）。
 */
export function t(key, lang) {
  const code = normalizeLang(lang);
  return MESSAGES[code]?.[key] ?? MESSAGES.en[key] ?? MESSAGES.zh[key] ?? key;
}

/**
 * 把一段 DOM 里的 data-i18n 标记翻译成目标语言。
 * - data-i18n="key"               → 替换 textContent
 * - data-i18n-placeholder="key"   → 设置 placeholder
 * - data-i18n-title="key"         → 设置 title（悬停提示）
 * 只处理纯文本元素；含子标签的段落不参与（避免把 `<b>` 之类冲掉）。
 */
export function applyI18n(root, lang) {
  if (!root?.querySelectorAll) return;
  const code = normalizeLang(lang);

  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n, code);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder, code);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle, code);
  });
  root.querySelectorAll('[data-lang-label]').forEach((el) => {
    const found = LANGUAGES.find((item) => item.code === el.dataset.langLabel);
    if (found) el.textContent = found.label;
  });
}

/** 整页级：顺带把 <html lang> 和 <title> 也改掉 */
export function applyI18nToDocument(lang, titleKey = 'appName') {
  const code = normalizeLang(lang);
  try {
    document.documentElement.lang = code === 'zh' ? 'zh-CN' : code;
    document.title = t(titleKey, code);
    applyI18n(document, code);
  } catch {
    /* 页面还没就绪时忽略 */
  }
}
