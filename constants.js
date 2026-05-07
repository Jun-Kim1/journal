const KCI_CONFIG = {
	baseUrl: process.env.KCI_BASE_URL || 'https://api.odcloud.kr/api',
	datasetPath: process.env.KCI_DATASET_PATH || '/15083283/v1/uddi:9cdf9a0d-6563-4dfe-9957-ecbe798c53e6',
	defaultServiceKey: process.env.KCI_API_KEY || ''
};

const CROSSREF_CONFIG = {
	baseUrl: 'https://api.crossref.org',
	worksPath: '/works',
	select: [
		'DOI',
		'title',
		'author',
		'published',
		'published-print',
		'published-online',
		'abstract',
		'container-title',
		'is-referenced-by-count',
		'URL',
		'subject',
		'type'
	].join(',')
};

const PAPER_TYPE_MAP = {
	'학술지': '학술지',
	'석사': '석사',
	'박사': '박사',
	'후보': '후보'
};

const ENTITY_SUBSTITUTION_MAP = {
	'학생': ['student', 'learner', 'undergraduate', 'college student', 'adolescent learner'],
	'교사': ['teacher', 'instructor', 'educator', 'faculty', 'school teacher'],
	'교수': ['professor', 'faculty member', 'academic staff', 'instructor', 'lecturer'],
	'학부모': ['parent', 'caregiver', 'guardian', 'family member', 'parental figure'],
	'직장인': ['employee', 'worker', 'professional', 'adult learner', 'office worker'],
	'관리자': ['manager', 'administrator', 'supervisor', 'decision maker', 'organizational leader'],
	'리더': ['leader', 'manager', 'supervisor', 'team leader', 'executive'],
	'팀': ['team', 'workgroup', 'project team', 'collaborative group', 'organization unit'],
	'노인': ['elderly', 'older adult', 'senior', 'aged population', 'older population'],
	'청소년': ['adolescent', 'teenager', 'youth', 'young person', 'secondary student'],
	'아동': ['child', 'children', 'young learner', 'pediatric population', 'school-age child'],
	'환자': ['patient', 'clinical population', 'care recipient', 'hospitalized patient', 'outpatient'],
	'의사': ['physician', 'doctor', 'clinician', 'medical practitioner', 'healthcare provider'],
	'간호사': ['nurse', 'nursing staff', 'healthcare worker', 'registered nurse', 'clinical nurse']
};

const CONCEPT_SYNONYM_MAP = {
	'인공지능': ['artificial intelligence', 'ai', 'intelligent systems', 'machine intelligence'],
	'생성형 ai': ['generative ai', 'genai', 'large language model', 'foundation model'],
	'ai': ['artificial intelligence', 'machine intelligence', 'intelligent systems'],
	'llm': ['large language model', 'foundation model', 'generative language model'],
	'챗봇': ['chatbot', 'conversational agent', 'dialogue system', 'virtual assistant'],
	'자동화': ['automation', 'process automation', 'workflow automation', 'task automation'],
	'교육': ['education', 'learning', 'instruction', 'pedagogy'],
	'학습': ['learning', 'study', 'knowledge acquisition', 'skill development'],
	'글쓰기': ['writing', 'academic writing', 'composition', 'writing proficiency'],
	'피드백': ['feedback', 'formative feedback', 'instructional feedback', 'assessment feedback'],
	'창의성': ['creativity', 'creative thinking', 'innovative thinking', 'idea generation'],
	'동기': ['motivation', 'learning motivation', 'engagement', 'self-determination'],
	'성과': ['performance', 'learning outcomes', 'achievement', 'academic performance'],
	'효과': ['effectiveness', 'impact', 'outcome effect', 'treatment effect'],
	'협업': ['collaboration', 'cooperative learning', 'teamwork', 'collaborative work'],
	'윤리': ['ethics', 'ai ethics', 'responsible ai', 'ethical considerations'],
	'신뢰': ['trust', 'trustworthiness', 'reliability', 'credibility'],
	'프라이버시': ['privacy', 'data privacy', 'information privacy', 'privacy protection'],
	'보안': ['security', 'information security', 'cybersecurity', 'data security'],
	'공정성': ['fairness', 'algorithmic fairness', 'equity', 'bias mitigation'],
	'편향': ['bias', 'algorithmic bias', 'systematic bias', 'representation bias'],
	'설명가능성': ['explainability', 'interpretable ai', 'model interpretability', 'xai'],
	'추천 시스템': ['recommender system', 'recommendation algorithm', 'personalized recommendation', 'recommendation model'],
	'시뮬레이션': ['simulation', 'computational simulation', 'scenario simulation', 'modeling simulation'],
	'데이터 분석': ['data analysis', 'analytics', 'statistical analysis', 'data-driven analysis']
};

const NOVELTY_THRESHOLDS = {
	P_S_HIGH_START: 0.85,
	P_S_MID_START: 0.4,
	P_S_MIN_AT_HIGH: 0.15
};

const ANALYSIS_STOP_WORDS = new Set([
	'연구', '분석', '고찰', '효과', '영향', '중심', '기반', '활용', '개발',
	'탐색', '비교', '검증', '대한', '에서', '위한', '및',
	'the', 'and', 'for', 'with', 'using', 'based', 'study', 'analysis',
	'approach', 'model', 'models', 'of', 'on', 'in', 'to', 'by', 'is', 'as',
	'an', 'a', 'at', 'from', 'this', 'that', 'it', 'be', 'are', 'or', 'was',
	'were', 'has', 'have', 'had', 'but', 'not', 'can', 'will', 'which',
	'their', 'its', 'these', 'those', 'such', 'into', 'between', 'among',
	'through', 'after', 'before', 'about', 'more', 'other', 'new', 'also',
	'than', 'been', 'may', 'one', 'two', 'three', 'four', 'five', 'six',
	'seven', 'eight', 'nine', 'ten'
]);

const NOVELTY_LABELS = [
	{ min: 78, label: '매우 참신함', tone: 'high', summary: '중복 연구 밀도가 낮고 희소성이 높습니다.' },
	{ min: 62, label: '차별화 가능', tone: 'medium-high', summary: '핵심 변수나 대상 집단을 좁히면 충분히 독창적입니다.' },
	{ min: 45, label: '선행연구 존재', tone: 'medium', summary: '유사 연구가 있으나 방법론 차별화로 기여 가능합니다.' },
	{ min: 0, label: '기존 연구 다수', tone: 'low', summary: '유사 주제 연구가 많아 차별화 설계가 필수입니다.' }
];

module.exports = {
	KCI_CONFIG,
	CROSSREF_CONFIG,
	PAPER_TYPE_MAP,
	ENTITY_SUBSTITUTION_MAP,
	CONCEPT_SYNONYM_MAP,
	NOVELTY_THRESHOLDS,
	ANALYSIS_STOP_WORDS,
	NOVELTY_LABELS
};
