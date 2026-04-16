const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_FILE = path.join(__dirname, 'journal.html');
const CROSSREF_MAILTO = 'huhuhu1013@naver.com';

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

const ARXIV_CONFIG = {
	baseUrl: 'https://export.arxiv.org/api/query',
	minIntervalMs: 3000,
	maxResultsCap: 60
};

const OPENALEX_CONFIG = {
	baseUrl: 'https://api.openalex.org/works',
	apiKey: process.env.OPENALEX_API_KEY || '',
	mailto: process.env.OPENALEX_MAILTO || CROSSREF_MAILTO,
	perPageCap: 100,
	select: [
		'id',
		'doi',
		'display_name',
		'publication_year',
		'type',
		'cited_by_count',
		'authorships',
		'primary_location',
		'concepts',
		'abstract_inverted_index',
		'ids',
		'best_oa_location'
	].join(',')
};

const LLM_EXPANSION_CONFIG = {
	baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
	apiKey: process.env.OPENAI_API_KEY || '',
	model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
	maxKeywordCount: 4,
	cacheLimit: 200,
	timeoutMs: 15000
};

const NANET_CONFIG = {
	baseUrl: 'https://www.nanet.go.kr/search/openApi/search.do',
	apiKey: process.env.NANET_API_KEY || '',
	perPageCap: 100
};

const NANET_DETAIL_CONFIG = {
	baseUrl: 'http://losi-api.nanet.go.kr',
	minConfidencePercent: 20,
	relJournalDefaultTopN: 10,
	relKeywordDefaultTopN: 10,
	maxKeywordCount: 100
};

let lastArxivRequestAt = 0;
const dynamicExpansionCache = new Map();

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
	'간호사': ['nurse', 'nursing staff', 'healthcare worker', 'registered nurse', 'clinical nurse'],
	'소비자': ['consumer', 'customer', 'user', 'buyer', 'end user'],
	'사용자': ['user', 'end user', 'system user', 'participant', 'consumer'],
	'운전자': ['driver', 'vehicle operator', 'road user', 'motorist', 'operator'],
	'농업인': ['farmer', 'agricultural worker', 'producer', 'rural worker', 'cultivator'],
	'제조업체': ['manufacturer', 'industrial firm', 'producer', 'factory operator', 'manufacturing company'],
	'로봇': ['robot', 'autonomous agent', 'robotic system', 'service robot', 'intelligent robot'],
	'센서': ['sensor', 'sensing device', 'detector', 'monitoring device', 'measurement device'],
	'알고리즘': ['algorithm', 'computational method', 'model', 'optimization method', 'learning algorithm'],
	'플랫폼': ['platform', 'digital platform', 'online system', 'service platform', 'technology platform'],
	'기업': ['firm', 'company', 'enterprise', 'business organization', 'corporation']
};

const CONCEPT_SYNONYM_MAP = {
	'자기효능감': ['self-efficacy', 'self-confidence', 'perceived competence', 'efficacy belief', 'personal efficacy'],
	'지속사용의도': ['continuance intention', 'continued use intention', 'behavioral intention', 'reuse intention', 'post-adoption intention'],
	'수용의도': ['acceptance intention', 'adoption intention', 'usage intention', 'behavioral intention', 'intention to use'],
	'학업성취': ['academic achievement', 'academic performance', 'learning outcome', 'scholastic attainment', 'educational outcome'],
	'만족도': ['satisfaction', 'user satisfaction', 'perceived satisfaction', 'service satisfaction', 'customer satisfaction'],
	'몰입': ['engagement', 'flow', 'immersion', 'involvement', 'learning engagement'],
	'신뢰': ['trust', 'perceived trust', 'reliability', 'trustworthiness', 'institutional trust'],
	'유용성': ['usefulness', 'perceived usefulness', 'utility', 'instrumentality', 'practical value'],
	'사용편의성': ['ease of use', 'usability', 'perceived ease of use', 'user friendliness', 'ease of operation'],
	'기술수용': ['technology acceptance', 'technology adoption', 'IT acceptance', 'digital adoption', 'system acceptance'],
	'학습동기': ['learning motivation', 'academic motivation', 'motivation to learn', 'study motivation', 'learner motivation'],
	'비판적사고': ['critical thinking', 'analytical thinking', 'higher-order thinking', 'reflective thinking', 'reasoning ability'],
	'문제해결력': ['problem-solving ability', 'problem-solving skill', 'solution competence', 'problem resolution', 'problem-solving competency'],
	'협업': ['collaboration', 'cooperation', 'teamwork', 'collaborative learning', 'joint work'],
	'창의성': ['creativity', 'creative thinking', 'innovative capacity', 'originality', 'creative performance'],
	'혁신': ['innovation', 'innovativeness', 'innovative behavior', 'technological innovation', 'organizational innovation'],
	'성과': ['performance', 'outcome', 'effectiveness', 'organizational performance', 'task performance'],
	'생산성': ['productivity', 'efficiency', 'work performance', 'output efficiency', 'operational productivity'],
	'번아웃': ['burnout', 'emotional exhaustion', 'occupational burnout', 'job burnout', 'work-related exhaustion'],
	'스트레스': ['stress', 'perceived stress', 'psychological stress', 'job stress', 'stress response'],
	'우울': ['depression', 'depressive symptom', 'depressive mood', 'mental distress', 'clinical depression'],
	'불안': ['anxiety', 'anxious symptom', 'psychological anxiety', 'state anxiety', 'trait anxiety'],
	'회복탄력성': ['resilience', 'psychological resilience', 'adaptive resilience', 'coping resilience', 'recovery capacity'],
	'삶의질': ['quality of life', 'well-being', 'life satisfaction', 'health-related quality of life', 'subjective well-being'],
	'사회적지지': ['social support', 'perceived social support', 'support network', 'interpersonal support', 'family support'],
	'조직몰입': ['organizational commitment', 'affective commitment', 'employee commitment', 'work commitment', 'institutional commitment'],
	'직무만족': ['job satisfaction', 'work satisfaction', 'employee satisfaction', 'occupational satisfaction', 'career satisfaction'],
	'리더십': ['leadership', 'leadership behavior', 'leadership style', 'transformational leadership', 'managerial leadership'],
	'윤리': ['ethics', 'ethical perception', 'ethical decision making', 'moral reasoning', 'research ethics'],
	'보안': ['security', 'information security', 'cybersecurity', 'system security', 'data security'],
	'프라이버시': ['privacy', 'data privacy', 'information privacy', 'privacy concern', 'privacy protection'],
	'설명가능성': ['explainability', 'interpretability', 'model transparency', 'algorithmic transparency', 'explainable AI'],
	'정확도': ['accuracy', 'predictive accuracy', 'classification accuracy', 'diagnostic accuracy', 'estimation accuracy'],
	'공정성': ['fairness', 'algorithmic fairness', 'equity', 'procedural fairness', 'distributive fairness'],
	'안전성': ['safety', 'system safety', 'operational safety', 'patient safety', 'functional safety'],
	'효율성': ['efficiency', 'operational efficiency', 'cost effectiveness', 'resource efficiency', 'process efficiency']
};

const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.css': 'text/css; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
	try {
		if (req.url.startsWith('/api/')) {
			setCorsHeaders(req, res);
			if (req.method === 'OPTIONS') {
				res.writeHead(204);
				res.end();
				return;
			}
		}

		const requestUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

		if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/journal.html')) {
			serveFile(STATIC_FILE, res);
			return;
		}

		if (req.method === 'GET' && requestUrl.pathname === '/health') {
			sendJson(res, 200, {
				ok: true,
				kciConfigured: Boolean(KCI_CONFIG.defaultServiceKey),
				nanetConfigured: Boolean(NANET_CONFIG.apiKey),
				openAlexConfigured: Boolean(OPENALEX_CONFIG.apiKey),
				llmExpansionConfigured: Boolean(LLM_EXPANSION_CONFIG.apiKey),
				sources: ['KCI', 'NANET', 'Global Journal'],
				crossrefPolitePool: true
			});
			return;
		}

		if (req.method === 'POST' && requestUrl.pathname === '/api/analyze') {
			const body = await readJsonBody(req);
			const data = await analyzeTopicSources(body);
			sendJson(res, 200, { ok: true, ...data });
			return;
		}

		if (req.method === 'POST' && requestUrl.pathname === '/api/openalex/search') {
			const body = await readJsonBody(req);
			const topic = String(body.topic || '').trim();
			if (!topic) {
				throw createError(400, '검색할 주제를 입력하세요.');
			}

			const rangeYears = clampNumber(body.rangeYears, 5, 3, 15);
			const currentYear = new Date().getFullYear();
			const fromYear = currentYear - rangeYears + 1;
			const untilYear = currentYear;
			const pageSize = clampNumber(body.pageSize, 60, 10, 120);
			const globalTypes = normalizeGlobalTypes(body.globalTypes, false);
			const translatedTopic = await translateTopicToEnglish(topic);
			const result = await searchOpenAlexWorks({
				topic,
				translatedTopic,
				fromYear,
				untilYear,
				globalTypes,
				pageSize,
				apiKey: OPENALEX_CONFIG.apiKey,
				mailto: OPENALEX_CONFIG.mailto
			});

			sendJson(res, 200, {
				ok: true,
				data: result.data,
				meta: {
					translatedTopic,
					fromYear,
					untilYear,
					globalTypes,
					totalCount: result.data.length,
					upstream: result.meta
				}
			});
			return;
		}

		if (req.method === 'POST' && requestUrl.pathname === '/api/nanet/rel-journal') {
			const body = await readJsonBody(req);
			const searchTerm = String(body.searchTerm || body.topic || '').trim();
			if (!searchTerm) {
				throw createError(400, 'searchTerm(검색어)을 입력하세요.');
			}

			const data = await getNanetRelJournalRecommendations({
				searchTerm,
				searchType: String(body.searchType || '통합').trim() || '통합',
				startYear: body.startYear,
				endYear: body.endYear,
				minConfidencePercent: clampNumber(body.minConfidencePercent, NANET_DETAIL_CONFIG.minConfidencePercent, 0, 100),
				topN: clampNumber(body.topN, NANET_DETAIL_CONFIG.relJournalDefaultTopN, 1, 50)
			});

			sendJson(res, 200, { ok: true, ...data });
			return;
		}

		if (req.method === 'POST' && requestUrl.pathname === '/api/nanet/article-trend') {
			const body = await readJsonBody(req);
			const searchTerm = String(body.searchTerm || body.topic || '').trim();
			if (!searchTerm) {
				throw createError(400, 'searchTerm(검색어)을 입력하세요.');
			}

			const data = await getNanetArticleTrend({ searchTerm });
			sendJson(res, 200, { ok: true, ...data });
			return;
		}

		if (req.method === 'POST' && requestUrl.pathname === '/api/nanet/rel-keyword') {
			const body = await readJsonBody(req);
			const searchTerm = String(body.searchTerm || body.topic || '').trim();
			if (!searchTerm) {
				throw createError(400, 'searchTerm(검색어)을 입력하세요.');
			}

			const data = await getNanetRelKeywordRecommendations({
				searchTerm,
				minConfidencePercent: clampNumber(body.minConfidencePercent, NANET_DETAIL_CONFIG.minConfidencePercent, 0, 100),
				topN: clampNumber(body.topN, NANET_DETAIL_CONFIG.relKeywordDefaultTopN, 1, 50)
			});

			sendJson(res, 200, { ok: true, ...data });
			return;
		}

		sendJson(res, 404, { ok: false, error: 'Not found' });
	} catch (error) {
		sendJson(res, error.statusCode || 500, {
			ok: false,
			error: error.message || 'Unexpected server error'
		});
	}
});

server.listen(PORT, HOST, () => {
	console.log(`Global paper analysis server running at http://localhost:${PORT}`);
});

async function analyzeTopicSources(payload) {
	const topic = String(payload.topic || '').trim();
	if (!topic) {
		throw createError(400, '검색할 논문 주제를 입력하세요.');
	}

	const includeKci = payload.includeKci !== false;
	const includeCrossref = payload.includeCrossref !== false;
	const globalTypes = normalizeGlobalTypes(payload.globalTypes, payload.includePreprint === true);
	const includePreprint = globalTypes.includes('preprint');
	if (!includeKci && !includeCrossref && !includePreprint) {
		throw createError(400, '최소 하나의 데이터 소스를 선택하세요.');
	}

	const rangeYears = clampNumber(payload.rangeYears, 5, 3, 15);
	const currentYear = new Date().getFullYear();
	const fromYear = currentYear - rangeYears + 1;
	const untilYear = currentYear;
	const pageSize = clampNumber(payload.pageSize, 80, 20, 200);
	const field = String(payload.field || 'all');
	const paperTypes = Array.isArray(payload.paperTypes) && payload.paperTypes.length ? payload.paperTypes : ['학술지'];
	const serviceKey = KCI_CONFIG.defaultServiceKey;
	const serviceKeyMode = String(payload.serviceKeyMode || 'auto');
	const nanetApiKey = NANET_CONFIG.apiKey;
	const openAlexApiKey = OPENALEX_CONFIG.apiKey;
	const openAlexMailto = OPENALEX_CONFIG.mailto;

	const queryPack = await buildQueryPack(topic);
	const translatedTopic = queryPack.translatedTopic;
	const globalQueryTopic = queryPack.globalQueryTopic;
	const globalQueryCandidates = [queryPack.primaryQueryEn, ...queryPack.expandedQueries].filter(Boolean).slice(0, 4);

	const kciTask = includeKci
		? searchKciPapers({
			topic,
			serviceKey,
			serviceKeyMode,
			pageSize: Math.max(25, Math.round(pageSize * 0.35)),
			paperTypes,
			field
		})
		: Promise.resolve({
			data: [],
			meta: { skipped: true, reason: 'KCI disabled by user' }
		});

	const nanetTask = includeKci && nanetApiKey
		? searchNanetPapers({
			topic,
			apiKey: nanetApiKey,
			pageSize: Math.max(20, Math.round(pageSize * 0.25)),
			fromYear,
			untilYear
		})
		: Promise.resolve({
			data: [],
			meta: { skipped: true, reason: nanetApiKey ? 'NANET disabled by user' : 'NANET API key not configured' }
		});

	const openAlexTask = includeCrossref
		? searchAcrossQueryVariants(globalQueryCandidates, (query) => searchOpenAlexWorks({
			topic,
			translatedTopic: query,
			fromYear,
			untilYear,
			globalTypes,
			pageSize: Math.max(30, Math.round(pageSize * 0.45)),
			apiKey: openAlexApiKey,
			mailto: openAlexMailto
		}), Math.max(30, Math.round(pageSize * 0.85)))
		: Promise.resolve({
			data: [],
			meta: { skipped: true, reason: 'OpenAlex disabled by user' }
		});

	const crossrefTask = includeCrossref
		? searchAcrossQueryVariants(globalQueryCandidates, (query) => searchCrossrefPapers({
			topic,
			translatedTopic: query,
			fromYear,
			untilYear,
			pageSize: Math.max(20, Math.round(pageSize * 0.3)),
			globalTypes
		}), Math.max(20, Math.round(pageSize * 0.55)))
		: Promise.resolve({
			data: [],
			nextCursor: '',
			meta: { skipped: true, reason: 'Crossref disabled by user' }
		});

	const arxivTask = includePreprint
		? searchAcrossQueryVariants(globalQueryCandidates, (query) => searchArxivPapers({
			topic,
			translatedTopic: query,
			fromYear,
			untilYear,
			pageSize: Math.max(15, Math.round(pageSize * 0.18))
		}), Math.max(20, Math.round(pageSize * 0.4)))
		: Promise.resolve({
			data: [],
			meta: { skipped: true, reason: 'Preprint disabled by user' }
		});

	const settled = await Promise.allSettled([kciTask, nanetTask, openAlexTask, crossrefTask, arxivTask]);

	const warnings = [];
	const kciResult = settled[0].status === 'fulfilled'
		? settled[0].value
		: handleSourceFailure('KCI', settled[0].reason, warnings);
	const nanetResult = settled[1].status === 'fulfilled'
		? settled[1].value
		: handleSourceFailure('NANET', settled[1].reason, warnings);
	const openAlexResult = settled[2].status === 'fulfilled'
		? settled[2].value
		: handleSourceFailure('OpenAlex', settled[2].reason, warnings);
	const crossrefResult = settled[3].status === 'fulfilled'
		? settled[3].value
		: handleSourceFailure('Crossref', settled[3].reason, warnings);
	const arxivResult = settled[4].status === 'fulfilled'
		? settled[4].value
		: handleSourceFailure('arXiv', settled[4].reason, warnings);
	const mergedDomestic = mergeDomesticSources(kciResult.data, nanetResult.data);
	const mergedGlobal = mergeGlobalSources(openAlexResult.data, crossrefResult.data, arxivResult.data);
	const merged = improvedDedupeByIdentifiers([...mergedDomestic, ...mergedGlobal]);
	const analysis = buildAnalysisReport({
		topic,
		rangeYears,
		field,
		pageSize,
		recentWeight: clampNumber(payload.recentWeight, 1, 0.5, 1.5),
		includeKci,
		includeCrossref,
		includePreprint,
		paperTypes,
		globalTypes,
		sortOrder: String(payload.sortOrder || 'latest')
	}, merged, {
		queryPack,
		translatedTopic,
		globalQueryTopic,
		domesticCount: mergedDomestic.length,
		globalCount: mergedGlobal.length,
		warnings
	});

	return {
		data: merged,
		analysis,
		meta: {
			warnings,
			translatedTopic,
			globalQueryTopic,
			queryPack,
			sources: {
				includeKci,
				includeCrossref,
				includePreprint
			},
			rangeYears,
			fromYear,
			untilYear,
			domesticCount: mergedDomestic.length,
			kciCount: kciResult.data.length,
			nanetCount: nanetResult.data.length,
			globalCount: mergedGlobal.length,
			openAlexCount: openAlexResult.data.length,
			crossrefCount: crossrefResult.data.length,
			preprintCount: arxivResult.data.length,
			totalCount: merged.length,
			crossrefCursor: crossrefResult.nextCursor,
			arxivQuery: arxivResult.meta && arxivResult.meta.requestUrl ? arxivResult.meta.requestUrl : '',
			openAlexQuery: openAlexResult.meta && openAlexResult.meta.requestUrl ? openAlexResult.meta.requestUrl : '',
			upstream: {
				kci: kciResult.meta,
				nanet: nanetResult.meta,
				openalex: openAlexResult.meta,
				crossref: crossrefResult.meta,
				preprint: arxivResult.meta
			}
		}
	};
}
function calculateConfidence(queryPack, papers) {
	const N_EXPECTED = 20;
	const countConfidence = Math.min(1.0, papers.length / N_EXPECTED);
	const allCorpusKws = new Set();
	papers.forEach((paper) => {
		(paper.keywords || []).forEach((keyword) => allCorpusKws.add(String(keyword).toLowerCase()));
	});

	const queryKeywords = dedupeStringArray([
		...((queryPack && queryPack.coreKeywordsEn) || []),
		...((queryPack && queryPack.coreKeywordsKo) || [])
	]).map((keyword) => String(keyword).toLowerCase());

	const keywordCoverage = queryKeywords.length
		? queryKeywords.filter((keyword) => allCorpusKws.has(keyword)).length / queryKeywords.length
		: 0.5;

	return Math.round(clampRange(countConfidence * keywordCoverage, 0.05, 1.0) * 1000) / 1000;
}

function buildAnalysisReport(cfg, records, meta) {
	const now = new Date().getFullYear();
	const minYear = now - cfg.rangeYears + 1;
	const topicTokens = tokenizeForAnalysis(cfg.topic);
	const queryPack = meta.queryPack || {
		coreKeywordsKo: topicTokens,
		coreKeywordsEn: []
	};

	const filtered = records.filter((record) => {
		const yearOk = !record.year || record.year >= minYear;
		const fieldOk = cfg.field === 'all' || String(record.field || '').includes(cfg.field);
		const typeLabel = String(record.type || '').toLowerCase();
		const globalTypeMap = { 'Global Journal': 'journal', 'Pre-print': 'preprint' };
		const globalType = globalTypeMap[record.source]
			|| (typeLabel.includes('master') || typeLabel.includes('석사') ? 'master' : (typeLabel.includes('doctor') || typeLabel.includes('박사') ? 'doctor' : 'journal'));

		const typeOk = (record.source === 'Global Journal' || record.source === 'Pre-print')
			? cfg.globalTypes.includes(globalType)
			: cfg.paperTypes.some((selectedType) => String(record.type || '').includes(selectedType));

		return yearOk && fieldOk && typeOk;
	});

	const scored = filtered.map((record) => {
		const titleScore = overlapScoreForAnalysis(topicTokens, tokenizeForAnalysis(record.title));
		const keywordScore = overlapScoreForAnalysis(topicTokens, tokenizeForAnalysis((record.keywords || []).join(' ')));
		const abstractScore = overlapScoreForAnalysis(topicTokens, tokenizeForAnalysis(record.abstract));
		const sourceWeight = (record.source === 'Global Journal' || record.source === 'Pre-print') ? 1.03 : 1;
		const similarity = clampRange((titleScore * 0.52 + keywordScore * 0.33 + abstractScore * 0.15) * sourceWeight, 0, 1);
		return { ...record, similarity };
	});

	const relevant = scored.filter((record) => record.similarity >= 0.08 || includesLooseMatchForAnalysis(cfg.topic, record));
	const sorted = sortRecordsForAnalysis(relevant, cfg.sortOrder);
	const topPapers = sorted.slice(0, 20);
	const similarities = topPapers.map((item) => Number(item.similarity || 0)).sort((a, b) => b - a);
	const S_max = similarities[0] || 0;
	const S_top5_avg = averageNumbers(similarities.slice(0, 5));
	const S_mixed = (0.6 * S_max) + (0.4 * S_top5_avg);

	let P_S = 1.0;
	if (S_mixed >= 0.85) {
		P_S = Math.max(0, 0.15 - (5 * (S_mixed - 0.85)));
	} else if (S_mixed >= 0.40) {
		P_S = 1 - (((S_mixed - 0.40) / 0.60) ** 2);
	}

	const similarPapersForT = scored.filter((paper) => Number(paper.similarity || 0) >= 0.5);
	const recentThreshold = now - 3;
	const C_recent = similarPapersForT.filter((paper) => paper.year && paper.year >= recentThreshold).length;
	const C_total = similarPapersForT.length;
	let T = 0.85;
	if (C_total > 0) {
		const T_raw = Math.exp(-2 * (C_recent / (C_total + 1)));
		const T_min = Math.exp(-2);
		T = clampRange((T_raw - T_min) / (1 - T_min), 0, 1);
	}

	const queryKeywords = dedupeStringArray([...(queryPack.coreKeywordsEn || []), ...(queryPack.coreKeywordsKo || [])]);
	const K = computePmiKeywordRarity(queryKeywords, relevant);
	const confidence = calculateConfidence(queryPack, relevant);
	const N_raw = clampRange(100 * ((0.5 * P_S) + (0.3 * T) + (0.2 * K)), 0, 100);
	const PENALTY_CAP = 50;
	const noveltyScore = Math.round(clampRange((relevant.length ? ((N_raw * confidence) + (PENALTY_CAP * (1 - confidence))) : PENALTY_CAP), 0, 100) * 10) / 10;

	const topAvg = averageNumbers(topPapers.map((item) => Number(item.similarity || 0)));
	const highSimilarityShare = relevant.length ? relevant.filter((item) => Number(item.similarity || 0) >= 0.45).length / relevant.length : 0;
	const recentShare = relevant.length ? relevant.filter((item) => item.year && item.year >= now - 4).length / relevant.length : 0;
	const yearDist = buildAnalysisYearDistribution(relevant, minYear, now);
	const keywordFreq = extractKeywordFrequencyForAnalysis(relevant, topicTokens);
	const scarcityScore = computeScarcityScore(relevant, topicTokens);
	const creativityScore = computeCombinationalCreativity(cfg.topic, relevant, keywordFreq);
	const verdict = classifyNovelty(noveltyScore, S_max);
	const translatedTopic = meta.globalQueryTopic || meta.translatedTopic || cfg.topic;
	const domesticCount = meta.domesticCount || 0;
	const globalCount = meta.globalCount || 0;
	const rationale = buildNoveltyRationale({ noveltyScore, topAvg, recentShare, scarcityScore, highSimilarityShare, domesticCount, globalCount });
	const recommendedKciJournals = buildRecommendedKciJournals(topPapers);
	const expectedCitationIndex = Math.round((averageNumbers(topPapers.map((paper) => Number(paper.citationCount || 0))) * 0.72) + (noveltyScore * 0.38));
	const rankedSimilarPapers = rankSimilarPapersForAnalysis(relevant, now, 20);
	const searchWarning = confidence < 0.5 ? `검색 신뢰도가 낮습니다 (${Math.round(confidence * 100)}%). 쿼리 확장 또는 범위 확대를 권장합니다.` : null;
	const gapAnalysis = buildGapAnalysisReport({
		cfg,
		noveltyScore,
		confidence,
		topAvg,
		recentShare,
		highSimilarityShare,
		scarcityScore,
		creativityScore,
		queryPack,
		keywordFreq,
		yearDist,
		similarPapers: rankedSimilarPapers,
		translatedTopic,
		matchCount: relevant.length
	});
	const reportNarrative = buildSpecReportNarrative({
		cfg,
		noveltyScore,
		confidence,
		verdict,
		translatedTopic,
		topAvg,
		recentShare,
		highSimilarityShare,
		gapAnalysis,
		keywordFreq,
		matchCount: relevant.length
	});

	return {
		noveltyScore,
		verdict,
		verdictTone: verdict.tone,
		verdictLabel: verdict.label,
		verdictSummary: verdict.summary,
		confidence,
		searchWarning,
		topAvg,
		topPapers,
		similarPapers: rankedSimilarPapers,
		recentShare,
		yearDist,
		keywordFreq,
		domesticCount,
		globalCount,
		translatedTopic,
		reportScope: `최근 ${cfg.rangeYears}년 기준 · 총 ${relevant.length}건 분석`,
		sourceSummary: `국내 저널 ${domesticCount}건 · 해외 저널 ${relevant.filter((item) => item.source === 'Global Journal').length}건 · 프리프린트 ${relevant.filter((item) => item.source === 'Pre-print').length}건`,
		matchCount: relevant.length,
		highSimilarityShare,
		scarcityScore,
		creativityScore,
		expectedCitationIndex,
		recommendedKciJournals,
		scoreBreakdown: {
			similarity: Math.round(P_S * 100),
			trend: Math.round(T * 100),
			scarcity: Math.round(K * 100),
			creativity: Math.round(creativityScore * 100)
		},
		gapAnalysis,
		reportNarrative,
		subScores: {
			similarityPenalty: { S_max, S_top5_avg, S_mixed, P_S, weight: 0.5 },
			temporalSparsity: { C_recent, C_total, T_score: T, weight: 0.3 },
			keywordRarity: { K_score: K, weight: 0.2 },
			confidence
		},
		rationale,
		insight: buildAnalysisInsight({ noveltyScore, recentShare, topAvg, domesticCount, globalCount, translatedTopic, keywordFreq, yearDist, highSimilarityShare, scarcityScore })
	};
}

function handleSourceFailure(sourceName, error, warnings) {
	let message = '일부 외부 데이터망 응답이 지연되어 수집 범위를 자동 조정했습니다.';
	if (sourceName === 'KCI' || sourceName === 'NANET') {
		message = '국내 데이터망 응답이 지연되어 해외 저널 중심으로 분석을 계속합니다.';
	} else if (sourceName === 'OpenAlex' || sourceName === 'Crossref' || sourceName === 'arXiv') {
		message = '해외 데이터망 응답이 지연되어 국내 저널 중심으로 분석을 계속합니다.';
	}
	warnings.push(message);
	return {
		data: [],
		meta: {
			skipped: true,
			reason: error && error.message ? error.message : `${sourceName} unavailable`
		}
	};
}

async function searchAcrossQueryVariants(queries, searchFn, maxResults) {
	const uniqueQueries = dedupeStringArray((queries || []).filter(Boolean)).slice(0, 4);
	if (!uniqueQueries.length) {
		return { data: [], meta: { skipped: true, reason: 'No query variants available' } };
	}

	const settled = await Promise.allSettled(uniqueQueries.map((query) => searchFn(query)));
	const mergedData = [];
	const requestUrls = [];
	const reasons = [];
	let nextCursor = '';

	settled.forEach((result, index) => {
		if (result.status !== 'fulfilled') {
			reasons.push(`${uniqueQueries[index]}: ${result.reason?.message || 'request failed'}`);
			return;
		}

		const value = result.value || {};
		mergedData.push(...(Array.isArray(value.data) ? value.data : []));
		if (value.nextCursor) {
			nextCursor = value.nextCursor;
		}
		const meta = value.meta || {};
		if (meta.requestUrl) {
			requestUrls.push(meta.requestUrl);
		}
		if (Array.isArray(meta.requestUrls)) {
			requestUrls.push(...meta.requestUrls);
		}
	});

	return {
		data: dedupeNormalizedRecords(mergedData).slice(0, maxResults),
		nextCursor,
		meta: {
			totalFetched: mergedData.length,
			queries: uniqueQueries,
			requestUrls: dedupeStringArray(requestUrls),
			reasons
		}
	};
}

async function searchKciPapers(options) {
	const { topic, serviceKey, serviceKeyMode, pageSize, paperTypes, field } = options;
	if (!serviceKey) {
		return { data: [], meta: { skipped: true, reason: 'No KCI service key' } };
	}

	const perType = Math.max(10, Math.ceil(pageSize / paperTypes.length));
	const responses = await Promise.all(paperTypes.map(async (paperType) => {
		const upstreamUrl = buildKciDatasetUrl({ topic, paperType, field, perPage: perType, serviceKey, serviceKeyMode });
		const json = await fetchJsonWithRetries(upstreamUrl, {
			headers: { Accept: 'application/json' },
			errorContext: `KCI ${paperType}`
		});
		return {
			paperType,
			url: upstreamUrl,
			items: extractKciRecords(json).map(normalizeKciRecord).filter(Boolean)
		};
	}));

	const merged = dedupeNormalizedRecords(responses.flatMap((entry) => entry.items)).slice(0, pageSize);
	return {
		data: merged,
		meta: {
			totalFetched: merged.length,
			upstreamUrls: responses.map((entry) => entry.url)
		}
	};
}

async function searchCrossrefPapers(options) {
	const { translatedTopic, fromYear, untilYear, pageSize, globalTypes = ['journal'] } = options;
	if (!globalTypes.length) {
		return { data: [], nextCursor: '', meta: { skipped: true, reason: 'No global type selected' } };
	}
	const queryTokens = tokenizeEnglish(translatedTopic);
	const perPage = Math.min(50, Math.max(20, Math.ceil(pageSize / 2)));
	const typeFilter = buildCrossrefTypeFilter(globalTypes);
	if (!typeFilter) {
		return { data: [], nextCursor: '', meta: { skipped: true, reason: 'No Crossref-compatible type selected' } };
	}
	let cursor = '*';
	let records = [];
	let page = 0;
	const urls = [];

	while (records.length < pageSize && cursor && page < 4) {
		const url = buildCrossrefUrl({ translatedTopic, fromYear, untilYear, cursor, rows: perPage, typeFilter });
		urls.push(url);
		const json = await fetchJsonWithRetries(url, {
			headers: {
				Accept: 'application/json',
				'User-Agent': `global-paper-analyzer/1.0 (mailto:${CROSSREF_MAILTO})`
			},
			errorContext: 'Crossref'
		});

		const message = json && json.message ? json.message : {};
		const items = Array.isArray(message.items) ? message.items : [];
		records = records.concat(
			items
				.map(normalizeCrossrefRecord)
				.filter(Boolean)
				.filter((record) => isRelevantCrossrefRecord(record, queryTokens))
		);
		cursor = message['next-cursor'] || '';
		page += 1;
		if (!items.length) {
			break;
		}
	}

	return {
		data: dedupeNormalizedRecords(records).slice(0, pageSize),
		nextCursor: cursor,
		meta: {
			totalFetched: records.length,
			requestUrls: urls
		}
	};
}

async function searchOpenAlexWorks(options) {
	const { translatedTopic, fromYear, untilYear, globalTypes, pageSize, apiKey, mailto } = options;

	const queryTokens = tokenizeEnglish(translatedTopic);
	const perPage = Math.min(OPENALEX_CONFIG.perPageCap, Math.max(20, pageSize));
	const requestUrl = buildOpenAlexUrl({
		translatedTopic,
		fromYear,
		untilYear,
		globalTypes,
		perPage,
		apiKey,
		mailto
	});
	const json = await fetchJsonWithRetries(requestUrl, {
		headers: {
			Accept: 'application/json',
			'User-Agent': `global-paper-analyzer/1.0 (mailto:${mailto || CROSSREF_MAILTO})`
		},
		errorContext: 'OpenAlex'
	});

	const items = Array.isArray(json?.results) ? json.results : [];
	const records = items
		.map(normalizeOpenAlexRecord)
		.filter(Boolean)
		.filter((record) => isRelevantCrossrefRecord(record, queryTokens));

	return {
		data: records,
		meta: {
			totalFetched: records.length,
			requestUrl,
			count: Number(json?.meta?.count) || records.length
		}
	};
}

async function searchNanetPapers(options) {
	const { topic, apiKey, pageSize, fromYear, untilYear } = options;

	if (!apiKey) {
		return { data: [], meta: { skipped: true, reason: 'No NANET API key' } };
	}

	try {
		const requestUrl = buildNanetUrl({
			topic,
			pageSize,
			apiKey
		});

		const response = await fetchJsonWithRetries(requestUrl, {
			headers: { Accept: 'application/json' },
			errorContext: 'NANET'
		});

		const records = Array.isArray(response?.documents)
			? response.documents
				.map((doc) => normalizeNanetRecord(doc, fromYear, untilYear))
				.filter(Boolean)
			: [];

		return {
			data: records,
			meta: {
				totalFetched: records.length,
				requestUrl,
				totalCount: Number(response?.totalCount) || records.length
			}
		};
	} catch (error) {
		return {
			data: [],
			meta: {
				skipped: true,
				reason: error && error.message ? error.message : 'NANET API request failed'
			}
		};
	}
}

async function translateTopicToEnglish(topic) {
	if (!/[가-힣]/.test(topic)) {
		return topic;
	}

	const translationUrl = new URL('https://api.mymemory.translated.net/get');
	translationUrl.searchParams.set('q', topic);
	translationUrl.searchParams.set('langpair', 'ko|en');
	translationUrl.searchParams.set('de', CROSSREF_MAILTO);

	try {
		const json = await fetchJsonWithRetries(translationUrl.toString(), {
			headers: { Accept: 'application/json' },
			errorContext: 'Translation'
		});
		const translated = String(json?.responseData?.translatedText || '').trim();
		if (!translated) {
			return topic;
		}
		const normalized = translated.replace(/\s+/g, ' ').trim();
		return normalized || topic;
	} catch (_error) {
		return topic;
	}
}

function normalizeKeywordKey(value) {
	return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function lookupStaticExpansion(keyword) {
	const normalizedKeyword = normalizeKeywordKey(keyword);
	const exactEntity = ENTITY_SUBSTITUTION_MAP[keyword] || ENTITY_SUBSTITUTION_MAP[normalizedKeyword];
	const exactConcept = CONCEPT_SYNONYM_MAP[keyword] || CONCEPT_SYNONYM_MAP[normalizedKeyword];
	if (!exactEntity && !exactConcept) {
		return null;
	}

	return {
		keyword,
		source: 'static',
		synonyms: dedupeStringArray(exactConcept || []),
		entities: dedupeStringArray(exactEntity || []),
		fallbackTranslation: ''
	};
}

function buildLlmExpansionPrompt(keyword, translatedKeyword) {
	return [
		'You are expanding an academic search keyword for literature retrieval.',
		`Input keyword: ${keyword}`,
		translatedKeyword && translatedKeyword !== keyword ? `Direct English translation: ${translatedKeyword}` : '',
		'Return compact JSON only with this schema:',
		'{"synonyms": ["..."], "entities": ["..."]}',
		'Synonyms: 3 to 5 English academic phrases for the same concept.',
		'Entities: 3 to 5 English population, actor, object, or counterpart phrases if applicable.',
		'Use terms suitable for Crossref, OpenAlex, and arXiv queries.',
		'Avoid explanations, markdown, duplicates, or very generic words.'
	].filter(Boolean).join('\n');
}

function trimCacheToLimit(cache, limit) {
	if (cache.size < limit) {
		return;
	}
	const oldestKey = cache.keys().next().value;
	if (oldestKey) {
		cache.delete(oldestKey);
	}
}

function sanitizeExpansionTerms(terms) {
	return dedupeStringArray((terms || [])
		.map((term) => String(term || '').replace(/["'`]/g, '').replace(/\s+/g, ' ').trim())
		.filter((term) => term.length >= 3)
	).slice(0, 5);
}

function safeParseExpansionPayload(content) {
	const raw = String(content || '').trim();
	if (!raw) {
		return null;
	}
	const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fencedMatch ? fencedMatch[1].trim() : raw;
	const objectMatch = candidate.match(/\{[\s\S]*\}/);
	if (!objectMatch) {
		return null;
	}

	try {
		return JSON.parse(objectMatch[0]);
	} catch (_error) {
		return null;
	}
}

async function requestLlmKeywordExpansion(keyword, translatedKeyword) {
	if (!LLM_EXPANSION_CONFIG.apiKey) {
		return null;
	}

	const cacheKey = normalizeKeywordKey(keyword);
	if (dynamicExpansionCache.has(cacheKey)) {
		return dynamicExpansionCache.get(cacheKey);
	}

	const url = `${LLM_EXPANSION_CONFIG.baseUrl.replace(/\/$/, '')}/responses`;
	const payload = {
		model: LLM_EXPANSION_CONFIG.model,
		input: buildLlmExpansionPrompt(keyword, translatedKeyword),
		max_output_tokens: 220,
		text: {
			format: {
				type: 'json_schema',
				name: 'academic_keyword_expansion',
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						synonyms: { type: 'array', items: { type: 'string' } },
						entities: { type: 'array', items: { type: 'string' } }
					},
					required: ['synonyms', 'entities']
				}
			}
		}
	};

	try {
		const json = await postJsonWithRetries(url, {
			headers: {
				Authorization: `Bearer ${LLM_EXPANSION_CONFIG.apiKey}`,
				'Content-Type': 'application/json'
			},
			body: payload,
			errorContext: 'LLM keyword expansion',
			timeoutMs: LLM_EXPANSION_CONFIG.timeoutMs
		});

		const outputText = String(json?.output_text || '')
			|| json?.output?.map((item) => item?.content?.map((part) => part?.text || '').join(' ')).join(' ')
			|| '';
		const parsed = safeParseExpansionPayload(outputText) || json;
		const result = {
			keyword,
			source: 'llm',
			synonyms: sanitizeExpansionTerms(parsed?.synonyms),
			entities: sanitizeExpansionTerms(parsed?.entities),
			fallbackTranslation: translatedKeyword || ''
		};

		if (!result.synonyms.length && !result.entities.length) {
			return null;
		}

		trimCacheToLimit(dynamicExpansionCache, LLM_EXPANSION_CONFIG.cacheLimit);
		dynamicExpansionCache.set(cacheKey, result);
		return result;
	} catch (_error) {
		return null;
	}
}

async function resolveAcademicKeywordExpansion(keyword) {
	const staticExpansion = lookupStaticExpansion(keyword);
	if (staticExpansion) {
		return staticExpansion;
	}

	const fallbackTranslation = await translateTopicToEnglish(keyword);
	const llmExpansion = await requestLlmKeywordExpansion(keyword, fallbackTranslation);
	if (llmExpansion) {
		return llmExpansion;
	}

	return {
		keyword,
		source: 'translation',
		synonyms: sanitizeExpansionTerms(fallbackTranslation && fallbackTranslation !== keyword ? [fallbackTranslation] : []),
		entities: [],
		fallbackTranslation: fallbackTranslation || ''
	};
}

function buildGlobalQueryText(topic, translatedTopic) {
	const original = String(topic || '').trim();
	const translated = String(translatedTopic || '').trim();
	const hasKorean = /[가-힣]/.test(original);

	if (!hasKorean) {
		return translated || original;
	}

	const englishTerms = expandKoreanAcademicTerms(original);
	const candidate = [];
	if (
		translated
		&& !isLowConfidenceTranslation(translated)
		&& !/[가-힣]/.test(translated)
		&& translated.toLowerCase() !== original.toLowerCase()
	) {
		candidate.push(translated);
	}
	if (englishTerms.length) {
		candidate.push(englishTerms.join(' '));
	}

	if (!candidate.length) {
		return original;
	}

	const mergedTokens = dedupeStringArray(candidate.join(' ').split(/\s+/)).slice(0, 24);
	return mergedTokens.join(' ');
}

async function buildQueryPack(topic) {
	const primaryQueryKo = String(topic || '').trim();
	const translatedTopic = await translateTopicToEnglish(primaryQueryKo);
	const baseEnglishQuery = buildGlobalQueryText(primaryQueryKo, translatedTopic);
	const coreKeywordsKo = extractCoreKeywords(primaryQueryKo);
	const expansionTargets = coreKeywordsKo.slice(0, LLM_EXPANSION_CONFIG.maxKeywordCount);
	const keywordExpansions = await Promise.all(expansionTargets.map((keyword) => resolveAcademicKeywordExpansion(keyword)));
	const coreKeywordsEn = dedupeStringArray(keywordExpansions.flatMap((item) => [
		...(item.synonyms || []).slice(0, 2),
		...(item.entities || []).slice(0, 1),
		item.fallbackTranslation || ''
	]));

	const primaryQueryEn = dedupeStringArray([
		...tokenizeEnglish(baseEnglishQuery),
		...coreKeywordsEn.flatMap((item) => String(item).split(/\s+/))
	]).slice(0, 24).join(' ') || baseEnglishQuery || primaryQueryKo;

	const expandedQueries = [];
	for (const expansion of keywordExpansions) {
		for (const alternative of (expansion.entities || []).slice(0, 3)) {
			expandedQueries.push(dedupeStringArray([...tokenizeEnglish(primaryQueryEn), ...alternative.split(/\s+/)]).slice(0, 24).join(' '));
		}

		for (const alternative of (expansion.synonyms || []).slice(1, 3)) {
			expandedQueries.push(dedupeStringArray([...tokenizeEnglish(primaryQueryEn), ...alternative.split(/\s+/)]).slice(0, 24).join(' '));
		}
	}

	return {
		primaryQueryKo,
		primaryQueryEn,
		translatedTopic,
		globalQueryTopic: primaryQueryEn,
		expandedQueries: dedupeStringArray(expandedQueries.filter(Boolean)).filter((query) => query && query !== primaryQueryEn).slice(0, 5),
		coreKeywordsKo,
		coreKeywordsEn: dedupeStringArray(coreKeywordsEn),
		keywordExpansionSources: keywordExpansions.map((item) => ({
			keyword: item.keyword,
			source: item.source,
			synonymCount: (item.synonyms || []).length,
			entityCount: (item.entities || []).length
		}))
	};
}

function extractCoreKeywords(topic) {
	const text = String(topic || '').trim();
	const matchedDictionaryTerms = [
		...Object.keys(CONCEPT_SYNONYM_MAP).filter((keyword) => text.includes(keyword)),
		...Object.keys(ENTITY_SUBSTITUTION_MAP).filter((keyword) => text.includes(keyword))
	];

	const tokenCandidates = text
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 2);

	return dedupeStringArray([...matchedDictionaryTerms, ...tokenCandidates]).slice(0, 8);
}

function isLowConfidenceTranslation(text) {
	const value = String(text || '').trim();
	if (!value || value.length < 4) {
		return true;
	}
	const questionMarks = (value.match(/\?/g) || []).length;
	if (questionMarks >= 2 || questionMarks / value.length > 0.12) {
		return true;
	}
	return false;
}

function expandKoreanAcademicTerms(topic) {
	const text = String(topic || '').toLowerCase();
	const glossary = [
		[/생성형|생성 ai/g, 'generative ai'],
		[/인공지능|ai\b/g, 'artificial intelligence'],
		[/대학|고등교육|대학교/g, 'university higher education'],
		[/교육|학습|교수법/g, 'education learning pedagogy'],
		[/글쓰기|작문/g, 'writing composition'],
		[/피드백/g, 'feedback'],
		[/자동화/g, 'automation'],
		[/평가|채점/g, 'assessment evaluation'],
		[/참신성|독창성/g, 'novelty originality'],
		[/논문|연구/g, 'research paper'],
		[/모델|알고리즘/g, 'model algorithm'],
		[/윤리|저작권/g, 'ethics copyright']
	];

	const terms = [];
	for (const [pattern, value] of glossary) {
		if (pattern.test(text)) {
			terms.push(value);
		}
	}
	return dedupeStringArray(terms);
}

function buildKciDatasetUrl(options) {
	const { topic, paperType, field, perPage, serviceKey, serviceKeyMode } = options;
	const params = new URLSearchParams();
	params.set('returnType', 'json');
	params.set('page', '1');
	params.set('perPage', String(perPage));
	params.set('cond[논문명::LIKE]', topic);

	const mappedType = PAPER_TYPE_MAP[paperType];
	if (mappedType) {
		params.set('cond[학위구분::EQ]', mappedType);
	}
	if (field && field !== 'all') {
		params.set('cond[학문분야::LIKE]', field);
	}

	return `${KCI_CONFIG.baseUrl}${KCI_CONFIG.datasetPath}?serviceKey=${buildServiceKeyPart(serviceKey, serviceKeyMode)}&${params.toString()}`;
}

function buildCrossrefUrl(options) {
	const { translatedTopic, fromYear, untilYear, cursor, rows, typeFilter = 'journal-article' } = options;
	const url = new URL(`${CROSSREF_CONFIG.baseUrl}${CROSSREF_CONFIG.worksPath}`);
	url.searchParams.set('mailto', CROSSREF_MAILTO);
	url.searchParams.set('query.bibliographic', translatedTopic);
	url.searchParams.set('filter', `from-pub-date:${fromYear}-01-01,until-pub-date:${untilYear}-12-31,type:${typeFilter}`);
	url.searchParams.set('select', CROSSREF_CONFIG.select);
	url.searchParams.set('sort', 'published');
	url.searchParams.set('order', 'desc');
	url.searchParams.set('rows', String(rows));
	url.searchParams.set('cursor', cursor);
	return url.toString();
}

function buildOpenAlexUrl(options) {
	const { translatedTopic, fromYear, untilYear, globalTypes, perPage, apiKey, mailto } = options;
	const url = new URL(OPENALEX_CONFIG.baseUrl);
	url.searchParams.set('search', translatedTopic);
	if (apiKey) {
		url.searchParams.set('api_key', apiKey);
	}
	url.searchParams.set('mailto', mailto || CROSSREF_MAILTO);
	url.searchParams.set('per-page', String(perPage));
	url.searchParams.set('sort', 'cited_by_count:desc');
	url.searchParams.set('select', OPENALEX_CONFIG.select);
	const typeFilter = buildOpenAlexTypeFilter(globalTypes);
	url.searchParams.set('filter', `type:${typeFilter},from_publication_date:${fromYear}-01-01,to_publication_date:${untilYear}-12-31`);
	return url.toString();
}

function buildNanetUrl(options) {
	const { topic, pageSize, apiKey } = options;
	const url = new URL(NANET_CONFIG.baseUrl);
	url.searchParams.set('key', apiKey);
	url.searchParams.set('query', topic);
	url.searchParams.set('pageSize', String(Math.min(pageSize, NANET_CONFIG.perPageCap)));
	url.searchParams.set('pageNum', '1');
	url.searchParams.set('resultType', 'json');
	url.searchParams.set('sort', 'RANK');
	return url.toString();
}

async function fetchJsonWithRetries(url, options) {
	const { headers = {}, errorContext = 'Request' } = options || {};
	let lastError = null;

	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(20000)
			});

			if (response.status === 429) {
				throw createError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
			}

			if (response.status >= 500) {
				throw createError(response.status, '논문 데이터 서버가 일시적으로 불안정합니다. 잠시 후 다시 시도하세요.');
			}

			if (!response.ok) {
				const message = await safeReadText(response);
				throw createError(response.status, `${errorContext} 요청 실패: ${message || response.statusText}`);
			}

			return response.json();
		} catch (error) {
			lastError = error;
			if (!shouldRetry(error) || attempt === 2) {
				throw error;
			}
			await wait(400 * (attempt + 1));
		}
	}

	throw lastError || createError(500, `${errorContext} failed`);
}

async function postJsonWithRetries(url, options) {
	const {
		headers = {},
		body = {},
		errorContext = 'Request',
		timeoutMs = 20000
	} = options || {};
	let lastError = null;

	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs)
			});

			if (response.status === 429) {
				throw createError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
			}

			if (response.status >= 500) {
				throw createError(response.status, '외부 확장 서버가 일시적으로 불안정합니다. 잠시 후 다시 시도하세요.');
			}

			if (!response.ok) {
				const message = await safeReadText(response);
				throw createError(response.status, `${errorContext} 요청 실패: ${message || response.statusText}`);
			}

			return response.json();
		} catch (error) {
			lastError = error;
			if (!shouldRetry(error) || attempt === 2) {
				throw error;
			}
			await wait(400 * (attempt + 1));
		}
	}

	throw lastError || createError(500, `${errorContext} failed`);
}

function normalizeKciRecord(record) {
	const title = pickValue(record, ['논문명', 'title', '논문제목', 'paperTitle']);
	if (!title) {
		return null;
	}

	const abstract = pickValue(record, ['초록', 'abstract', '요약']);
	const keywords = pickKeywordList(pickValue(record, ['키워드', '주제어', 'keyword', 'keywords']));
	const yearRaw = pickValue(record, ['발행연도', '발행년도', 'year']);
	const author = pickValue(record, ['저자명', 'author', 'authors']) || '저자 미상';
	const type = pickValue(record, ['학위구분', '논문유형', 'type']) || '국내 논문';
	const field = pickValue(record, ['학문분야', '주제분야', 'field']) || '미상';
	const journal = pickValue(record, ['학술지명', '발행기관', 'journal']) || '국내 학술자료';
	const citationCount = Number(String(pickValue(record, ['인용횟수', '피인용횟수', 'citationCount']) || 0).replace(/[^0-9.]/g, '')) || 0;
	const doi = pickValue(record, ['DOI', 'doi']);

	return {
		title: String(title).trim(),
		abstract: stripHtml(String(abstract || '').trim()),
		keywords,
		year: normalizeYear(yearRaw),
		author: normalizeAuthorString(author),
		type: String(type).trim(),
		field: String(field).trim(),
		journal: String(journal).trim(),
		citationCount,
		doi: doi ? String(doi).trim() : '',
		url: '',
		source: 'KCI',
		language: 'ko'
	};
}

function normalizeCrossrefRecord(record) {
	const title = Array.isArray(record.title) ? record.title[0] : record.title;
	if (!title) {
		return null;
	}

	const author = Array.isArray(record.author)
		? record.author.map((entry) => [entry.given, entry.family].filter(Boolean).join(' ')).filter(Boolean).join(', ')
		: 'Author unknown';
	const year = normalizeCrossrefYear(record);
	const abstract = stripHtml(String(record.abstract || '').trim());
	const journal = Array.isArray(record['container-title']) ? record['container-title'][0] || 'International Journal' : (record['container-title'] || 'International Journal');
	const subjects = Array.isArray(record.subject) ? record.subject : [];

	return {
		title: String(title).trim(),
		abstract,
		keywords: subjects.map((item) => String(item).trim()).filter(Boolean),
		year,
		author: author || 'Author unknown',
		type: mapCrossrefType(record.type),
		field: subjects[0] ? String(subjects[0]).trim() : 'Global Research',
		journal: String(journal).trim(),
		citationCount: Number(record['is-referenced-by-count']) || 0,
		doi: normalizeDoi(String(record.DOI || '').trim()),
		url: String(record.URL || '').trim(),
		source: 'Global Journal',
		language: String(record.language || 'en').trim(),
		openalexId: '',
		arxivId: ''
	};
}

function normalizeOpenAlexRecord(record) {
	if (!record || !record.display_name) {
		return null;
	}

	const type = mapOpenAlexType(record);
	const primarySource = record?.primary_location?.source?.display_name || record?.host_venue?.display_name || 'Global Source';
	const authors = Array.isArray(record.authorships)
		? record.authorships.map((entry) => entry?.author?.display_name).filter(Boolean)
		: [];
	const concepts = Array.isArray(record.concepts) ? record.concepts.map((item) => item?.display_name).filter(Boolean) : [];
	const ids = record?.ids || {};
	return {
		title: String(record.display_name).trim(),
		abstract: stripHtml(invertedIndexToText(record.abstract_inverted_index)),
		keywords: concepts.map((item) => String(item).trim()).filter(Boolean),
		year: Number(record.publication_year) || null,
		author: authors.length ? authors.join(', ') : 'Author unknown',
		type,
		field: concepts[0] ? String(concepts[0]).trim() : 'Global Research',
		journal: String(primarySource).trim(),
		citationCount: Number(record.cited_by_count) || 0,
		doi: normalizeDoi(record.doi || ids.doi || ''),
		url: String(record?.best_oa_location?.landing_page_url || record?.primary_location?.landing_page_url || ids?.openalex || '').trim(),
		source: 'Global Journal',
		language: 'en',
		openalexId: String(record.id || '').trim(),
		arxivId: ''
	};
}

function normalizeNanetRecord(record, fromYear, untilYear) {
	if (!record || !record.title) {
		return null;
	}

	const year = Number(record.publishYear) || Number(record.year) || null;
	if (year && (year < fromYear || year > untilYear)) {
		return null;
	}

	const title = String(record.title || record.titleText || '').trim();
	if (!title) {
		return null;
	}

	const author = String(record.author || record.authorName || '저자 미상').trim();
	const abstract = stripHtml(String(record.abstract || record.description || '').trim());
	const keywords = Array.isArray(record.keyword)
		? record.keyword.map((item) => String(item).trim()).filter(Boolean)
		: [];
	const doi = String(record.doi || record.DOI || '').trim();
	const journal = String(record.publicationTitle || record.journal || '국내 학술자료').trim();

	return {
		title,
		abstract,
		keywords,
		year,
		author,
		type: '국내 논문',
		field: String(record.field || record.discipline || '국내 학술').trim(),
		journal,
		citationCount: Number(record.citationCount) || 0,
		doi: normalizeDoi(doi),
		url: String(record.url || record.link || '').trim(),
		source: 'NANET',
		language: 'ko',
		openalexId: '',
		arxivId: '',
		nanetId: String(record.id || record.resourceId || '').trim()
	};
}

function extractKciRecords(payload) {
	if (!payload) {
		return [];
	}
	if (Array.isArray(payload)) {
		return payload;
	}
	if (Array.isArray(payload.data)) {
		return payload.data;
	}
	if (Array.isArray(payload.items)) {
		return payload.items;
	}
	return [];
}

function normalizeTitle(title) {
	if (!title) {
		return '';
	}
	return String(title)
		.toLowerCase()
		.trim()
		.replace(/[\s\-\.\,\;\:\(\)\[\]\{\}]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function mergeDomesticSources(kciRecords, nanetRecords) {
	const merged = [];
	const titleIndex = new Map();

	for (const record of kciRecords) {
		const normalizedTitle = normalizeTitle(record.title);
		if (normalizedTitle) {
			titleIndex.set(normalizedTitle, record);
		}
		merged.push(record);
	}

	for (const record of nanetRecords) {
		const normalizedTitle = normalizeTitle(record.title);
		if (normalizedTitle && titleIndex.has(normalizedTitle)) {
			const base = titleIndex.get(normalizedTitle);
			base.citationCount = Math.max(Number(base.citationCount) || 0, Number(record.citationCount) || 0);
			base.keywords = dedupeStringArray([...(base.keywords || []), ...(record.keywords || [])]);
			if (!base.doi && record.doi) {
				base.doi = record.doi;
			}
			if (!base.url && record.url) {
				base.url = record.url;
			}
			continue;
		}
		merged.push(record);
		if (normalizedTitle) {
			titleIndex.set(normalizedTitle, record);
		}
	}

	return merged;
}

function improvedDedupeByIdentifiers(records) {
	const seen = new Set();
	const deduped = [];

	for (const record of records) {
		if (!record || !record.title) {
			continue;
		}

		const doi = normalizeDoi(record.doi || '');
		const openalexId = String(record.openalexId || '').trim().toLowerCase();
		const arxivId = normalizeArxivIdentifier(record.arxivId || record.url || '');
		const nanetId = String(record.nanetId || '').trim().toLowerCase();
		const normalizedTitle = normalizeTitle(record.title);
		const titleYear = normalizedTitle && record.year ? `${normalizedTitle}::${record.year}` : '';
		const titleYearAuthor = titleYear && record.author
			? `${titleYear}::${String(record.author).toLowerCase().trim()}`
			: '';

		const keys = [
			doi ? `doi:${doi}` : '',
			openalexId ? `openalex:${openalexId}` : '',
			arxivId ? `arxiv:${arxivId}` : '',
			nanetId ? `nanet:${nanetId}` : '',
			titleYearAuthor ? `title_year_author:${titleYearAuthor}` : '',
			titleYear ? `title_year:${titleYear}` : '',
			normalizedTitle ? `title:${normalizedTitle}` : ''
		].filter(Boolean);

		const alreadySeen = keys.some((key) => seen.has(key));
		if (alreadySeen) {
			continue;
		}

		keys.forEach((key) => seen.add(key));
		deduped.push(record);
	}

	return deduped;
}

function dedupeNormalizedRecords(records) {
	return dedupeByIdentifiers(records);
}

function mergeGlobalSources(openAlexRecords, crossrefRecords, arxivRecords) {
	const mergedByDoi = mergeByDoi(openAlexRecords, crossrefRecords);
	const mergedByArxiv = dedupeByArxivIdentifier([...mergedByDoi, ...arxivRecords]);
	return dedupeByIdentifiers(mergedByArxiv);
}

function dedupeByIdentifiers(records) {
	const seen = new Set();
	const deduped = [];

	for (const record of records) {
		if (!record || !record.title) {
			continue;
		}

		const doi = normalizeDoi(record.doi || '');
		const openalexId = String(record.openalexId || '').trim().toLowerCase();
		const arxivId = normalizeArxivIdentifier(record.arxivId || record.url || '');
		const fallback = `${String(record.title || '').trim().toLowerCase()}::${record.year || ''}::${String(record.author || '').trim().toLowerCase()}`;
		const keys = [
			doi ? `doi:${doi}` : '',
			openalexId ? `openalex:${openalexId}` : '',
			arxivId ? `arxiv:${arxivId}` : '',
			`fallback:${fallback}`
		].filter(Boolean);

		const alreadySeen = keys.some((key) => seen.has(key));
		if (alreadySeen) {
			continue;
		}

		keys.forEach((key) => seen.add(key));
		deduped.push(record);
	}

	return deduped;
}

function mergeByDoi(primaryRecords, secondaryRecords) {
	const merged = [];
	const index = new Map();

	for (const record of primaryRecords) {
		const key = normalizeDoi(record.doi);
		if (key) {
			index.set(key, record);
		}
		merged.push(record);
	}

	for (const record of secondaryRecords) {
		const key = normalizeDoi(record.doi);
		if (key && index.has(key)) {
			const base = index.get(key);
			base.citationCount = Math.max(Number(base.citationCount) || 0, Number(record.citationCount) || 0);
			base.keywords = dedupeStringArray([...(base.keywords || []), ...(record.keywords || [])]);
			if (!base.url && record.url) {
				base.url = record.url;
			}
			continue;
		}
		merged.push(record);
		if (key) {
			index.set(key, record);
		}
	}

	return merged;
}

function dedupeByArxivIdentifier(records) {
	const seen = new Set();
	const result = [];

	for (const record of records) {
		const arxivId = normalizeArxivIdentifier(record.arxivId || record.url || '');
		const key = arxivId ? `arxiv:${arxivId}` : '';
		if (key && seen.has(key)) {
			continue;
		}
		if (key) {
			seen.add(key);
		}
		result.push(record);
	}

	return result;
}

function normalizeCrossrefYear(record) {
	const parts = record?.published?.['date-parts'] || record?.['published-print']?.['date-parts'] || record?.['published-online']?.['date-parts'];
	if (Array.isArray(parts) && Array.isArray(parts[0]) && parts[0][0]) {
		return Number(parts[0][0]);
	}
	return null;
}

function mapCrossrefType(type) {
	if (!type) {
		return '학술지';
	}
	const normalized = String(type).toLowerCase();
	if (normalized.includes('dissertation') || normalized.includes('thesis')) {
		if (normalized.includes('master')) {
			return '석사 논문';
		}
		if (normalized.includes('doctor') || normalized.includes('phd')) {
			return '박사 논문';
		}
		return '박사 논문';
	}
	if (normalized.includes('journal')) {
		return '학술지';
	}
	return '학술지';
}

function mapOpenAlexType(record) {
	const rawType = String(record?.type || '').toLowerCase();
	if (rawType === 'dissertation') {
		return classifyDissertationLevel(record);
	}
	return '학술지';
}

function classifyDissertationLevel(record) {
	const text = `${record?.display_name || ''} ${invertedIndexToText(record?.abstract_inverted_index || {})}`.toLowerCase();
	if (/(master|msc|m\.a\.|석사)/.test(text)) {
		return '석사 논문';
	}
	return '박사 논문';
}

function buildOpenAlexTypeFilter(globalTypes) {
	const mapped = [];
	if (globalTypes.includes('journal')) {
		mapped.push('article');
	}
	if (globalTypes.includes('master') || globalTypes.includes('doctor')) {
		mapped.push('dissertation');
	}
	return dedupeStringArray(mapped).join('|') || 'article';
}

function buildCrossrefTypeFilter(globalTypes) {
	const mapped = [];
	if (globalTypes.includes('journal')) {
		mapped.push('journal-article');
	}
	if (globalTypes.includes('master') || globalTypes.includes('doctor')) {
		mapped.push('dissertation');
	}
	return dedupeStringArray(mapped).join('|');
}

function normalizeGlobalTypes(globalTypes, includePreprintFallback) {
	const incoming = Array.isArray(globalTypes) ? globalTypes.map((item) => String(item).trim().toLowerCase()) : [];
	const allowed = ['journal', 'preprint'];
	const normalized = incoming.filter((item) => allowed.includes(item));
	if (!normalized.length) {
		normalized.push('journal');
	}
	if (includePreprintFallback && !normalized.includes('preprint')) {
		normalized.push('preprint');
	}
	return dedupeStringArray(normalized);
}

function computeCombinationalCreativity(topic, records, keywordFreq) {
	const topicTokens = tokenizeForAnalysis(topic).slice(0, 6);
	if (topicTokens.length < 2 || !records.length) {
		return 0.3;
	}

	const connectorTerms = ['and', '융합', '혼합', 'interdisciplinary', 'cross', 'hybrid', 'fusion'];
	const connectorBonus = connectorTerms.some((term) => String(topic).toLowerCase().includes(term)) ? 0.16 : 0;

	const keywordSet = new Set((keywordFreq || []).slice(0, 14).map((item) => String(item.keyword || '').toLowerCase()));
	const pairCount = [];
	for (let i = 0; i < topicTokens.length; i += 1) {
		for (let j = i + 1; j < topicTokens.length; j += 1) {
			const pair = `${topicTokens[i]} ${topicTokens[j]}`;
			const count = records.filter((record) => {
				const haystack = `${record.title || ''} ${record.abstract || ''}`.toLowerCase();
				return haystack.includes(pair);
			}).length;
			pairCount.push(count / records.length);
		}
	}

	const noveltyByPair = 1 - averageNumbers(pairCount);
	const keywordNovelty = topicTokens.filter((token) => !keywordSet.has(token)).length / topicTokens.length;
	return clampRange((noveltyByPair * 0.62) + (keywordNovelty * 0.28) + connectorBonus, 0.08, 0.96);
}

function buildRecommendedKciJournals(records) {
	const journalMap = new Map();
	records
		.filter((record) => record.source === 'KCI' && record.journal)
		.forEach((record) => {
			const key = String(record.journal).trim();
			if (!key) {
				return;
			}
			const current = journalMap.get(key) || { journal: key, count: 0, similarityTotal: 0, recentCount: 0 };
			current.count += 1;
			current.similarityTotal += Number(record.similarity || 0);
			if (record.year && record.year >= new Date().getFullYear() - 2) {
				current.recentCount += 1;
			}
			journalMap.set(key, current);
		});

	return Array.from(journalMap.values())
		.map((item) => ({
			journal: item.journal,
			count: item.count,
			recentCount: item.recentCount,
			avgSimilarity: item.count ? item.similarityTotal / item.count : 0
		}))
		.sort((a, b) => (b.count - a.count) || (b.recentCount - a.recentCount) || (a.avgSimilarity - b.avgSimilarity))
		.slice(0, 8);
}

function dedupeStringArray(values) {
	return Array.from(new Set((values || []).filter(Boolean).map((item) => String(item).trim())));
}

function normalizeDoi(value) {
	const raw = String(value || '').trim();
	if (!raw) {
		return '';
	}
	return raw.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
}

function normalizeArxivIdentifier(value) {
	const raw = String(value || '').trim();
	if (!raw) {
		return '';
	}
	const match = raw.match(/(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:)([a-zA-Z0-9.\-\/]+)/i);
	if (match && match[1]) {
		return match[1].replace(/\.pdf$/i, '').trim().toLowerCase();
	}
	if (raw.startsWith('https://openalex.org/')) {
		return '';
	}
	return raw.toLowerCase();
}

function invertedIndexToText(index) {
	if (!index || typeof index !== 'object') {
		return '';
	}
	const entries = [];
	for (const [word, positions] of Object.entries(index)) {
		if (!Array.isArray(positions)) {
			continue;
		}
		for (const pos of positions) {
			entries.push([Number(pos), word]);
		}
	}
	entries.sort((a, b) => a[0] - b[0]);
	return entries.map((entry) => entry[1]).join(' ');
}

function pickValue(record, keys) {
	for (const key of keys) {
		if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
			return record[key];
		}
	}
	return '';
}

function pickKeywordList(value) {
	if (Array.isArray(value)) {
		return value.flatMap((item) => pickKeywordList(item));
	}
	if (value && typeof value === 'object') {
		return Object.values(value).flatMap((item) => pickKeywordList(item));
	}
	return String(value || '').split(/[;,|/\n]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeYear(value) {
	const match = String(value || '').match(/(19|20)\d{2}/);
	return match ? Number(match[0]) : null;
}

function normalizeAuthorString(author) {
	if (Array.isArray(author)) {
		return author.join(', ');
	}
	return String(author || '').trim();
}

function buildServiceKeyPart(serviceKey, mode) {
	if (mode === 'encoded') {
		return serviceKey;
	}
	if (mode === 'decoded') {
		return encodeURIComponent(serviceKey);
	}
	try {
		const decoded = decodeURIComponent(serviceKey);
		return encodeURIComponent(decoded);
	} catch (_error) {
		return encodeURIComponent(serviceKey);
	}
}

async function nanetApiRequest(endpoint, data) {
	const authKey = String(process.env.NANET_API_KEY || '').trim();
	if (!authKey) {
		throw createError(500, 'NANET_API_KEY 환경변수가 설정되지 않았습니다.');
	}

	const url = `${NANET_DETAIL_CONFIG.baseUrl}${endpoint}`;
	const payload = {
		authKey,
		...(data || {})
	};

	try {
		const body = new URLSearchParams();
		for (const [key, value] of Object.entries(payload)) {
			if (value !== undefined && value !== null && String(value).trim() !== '') {
				body.set(key, String(value));
			}
		}

		const response = await axios.post(url, body.toString(), {
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json'
			},
			timeout: 20000
		});

		const resultCode = String(response?.data?.resultCode || response?.data?.code || '').trim();
		const resultMsg = String(response?.data?.resultMsg || response?.data?.message || '').trim();
		if (resultCode && !['0', '00', 'success', 'SUCCESS'].includes(resultCode)) {
			if (/인증|auth|key|unauthorized|forbidden/i.test(resultCode + resultMsg)) {
				throw createError(401, `NANET 인증 오류: ${resultMsg || resultCode}`);
			}
			throw createError(502, `NANET 응답 오류: ${resultMsg || resultCode}`);
		}

		return response.data;
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		if (error.response) {
			const status = Number(error.response.status) || 502;
			const message = extractAxiosErrorMessage(error.response.data) || error.message || 'NANET API 응답 오류';
			if (status === 401 || status === 403) {
				throw createError(401, `NANET 인증 오류: ${message}`);
			}
			throw createError(502, `NANET API 요청 실패: ${message}`);
		}
		if (error.request) {
			throw createError(504, 'NANET API 서버 응답이 없습니다. 잠시 후 다시 시도하세요.');
		}
		throw createError(500, `NANET API 처리 중 오류: ${error.message || 'Unknown error'}`);
	}
}

async function getNanetRelJournalRecommendations(options) {
	const {
		searchTerm,
		searchType = '통합',
		startYear,
		endYear,
		minConfidencePercent = NANET_DETAIL_CONFIG.minConfidencePercent,
		topN = NANET_DETAIL_CONFIG.relJournalDefaultTopN
	} = options;

	const response = await nanetApiRequest('/relJournal', {
		searchTerm,
		searchType,
		startYear,
		endYear
	});

	const sourceList = pickNanetList(response, ['result.journalList', 'journalList', 'result.list', 'list']);
	const normalized = sourceList.map((item, index) => {
		const rank = Number(item?.number || item?.rank || index + 1) || index + 1;
		const name = String(item?.name || item?.journalName || item?.title || '').trim();
		const confidence = calculateRankConfidence(rank, sourceList.length, item?.score || item?.relScore || item?.weight);
		return {
			rank,
			name,
			confidence,
			rationale: `순위 ${rank} 기반 연관성 ${confidence}%`
		};
	}).filter((item) => item.name);

	const filtered = normalized
		.filter((item) => item.confidence >= minConfidencePercent)
		.filter((item) => isNanetRelevant(item.name, searchTerm, item.confidence));

	const top = filtered.slice(0, topN);
	return {
		data: top,
		meta: {
			searchTerm,
			searchType,
			requestedTopN: topN,
			totalFromApi: sourceList.length,
			afterNoiseFilter: filtered.length,
			droppedLowConfidence: normalized.length - filtered.length
		}
	};
}

async function getNanetArticleTrend(options) {
	const { searchTerm } = options;
	const response = await nanetApiRequest('/articleTrend', { searchTerm });
	const trendList = pickNanetList(response, ['result.trendList', 'trendList', 'result.list', 'list']);

	const trend = trendList
		.map((item) => ({
			year: Number(item?.year || item?.publishYear || item?.date),
			count: Number(item?.count || item?.cnt || item?.value || 0)
		}))
		.filter((item) => Number.isFinite(item.year) && item.year > 0)
		.sort((a, b) => a.year - b.year);

	return {
		data: trend,
		meta: {
			searchTerm,
			points: trend.length,
			totalCount: trend.reduce((sum, item) => sum + (Number(item.count) || 0), 0)
		}
	};
}

async function getNanetRelKeywordRecommendations(options) {
	const {
		searchTerm,
		minConfidencePercent = NANET_DETAIL_CONFIG.minConfidencePercent,
		topN = NANET_DETAIL_CONFIG.relKeywordDefaultTopN
	} = options;

	const response = await nanetApiRequest('/relKeyword', { searchTerm });
	const sourceList = pickNanetList(response, ['result.keywordList', 'keywordList', 'result.relKeywordList', 'relKeywordList', 'result.list', 'list']);

	const normalized = sourceList.slice(0, NANET_DETAIL_CONFIG.maxKeywordCount).map((item, index) => {
		const rank = Number(item?.number || item?.rank || index + 1) || index + 1;
		const keyword = String(item?.name || item?.keyword || item?.term || '').trim();
		const confidence = calculateRankConfidence(rank, sourceList.length, item?.score || item?.relScore || item?.weight);
		return {
			rank,
			keyword,
			confidence,
			rationale: `순위 ${rank} 기반 연관성 ${confidence}%`
		};
	}).filter((item) => item.keyword);

	const filtered = normalized
		.filter((item) => item.confidence >= minConfidencePercent)
		.filter((item) => isNanetRelevant(item.keyword, searchTerm, item.confidence));

	return {
		data: filtered,
		top10: filtered.slice(0, topN),
		meta: {
			searchTerm,
			requestedTopN: topN,
			totalFromApi: sourceList.length,
			afterNoiseFilter: filtered.length,
			droppedLowConfidence: normalized.length - filtered.length
		}
	};
}

function pickNanetList(payload, candidates) {
	for (const pathName of candidates) {
		const value = getByPath(payload, pathName);
		if (Array.isArray(value)) {
			return value;
		}
	}
	return [];
}

function getByPath(obj, pathName) {
	if (!obj || !pathName) {
		return undefined;
	}
	return pathName.split('.').reduce((acc, key) => {
		if (acc && typeof acc === 'object' && key in acc) {
			return acc[key];
		}
		return undefined;
	}, obj);
}

function calculateRankConfidence(rank, total, score) {
	const numericScore = Number(score);
	if (Number.isFinite(numericScore) && numericScore > 0) {
		if (numericScore <= 1) {
			return Math.max(0, Math.min(100, Math.round(numericScore * 100)));
		}
		return Math.max(0, Math.min(100, Math.round(numericScore)));
	}
	const safeTotal = Math.max(1, Number(total) || 1);
	const normalizedRank = Math.max(1, Number(rank) || 1);
	if (safeTotal === 1) {
		return 100;
	}
	const percent = 100 - ((normalizedRank - 1) / (safeTotal - 1)) * 100;
	return Math.max(0, Math.min(100, Math.round(percent)));
}

function isNanetRelevant(text, searchTerm, confidence) {
	const normalizedText = normalizeTitle(text);
	const normalizedQuery = normalizeTitle(searchTerm);
	if (!normalizedText || !normalizedQuery) {
		return false;
	}
	if (normalizedText.includes(normalizedQuery) || normalizedQuery.includes(normalizedText)) {
		return true;
	}
	const queryTokens = normalizedQuery.split(' ').filter(Boolean);
	const textTokens = normalizedText.split(' ').filter(Boolean);
	const overlap = queryTokens.filter((token) => textTokens.includes(token)).length;
	if (overlap >= Math.max(1, Math.floor(queryTokens.length * 0.3))) {
		return true;
	}
	return Number(confidence) >= 60;
}

function extractAxiosErrorMessage(data) {
	if (!data) {
		return '';
	}
	if (typeof data === 'string') {
		return data.trim();
	}
	return String(data?.resultMsg || data?.message || data?.error || '').trim();
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let raw = '';
		req.on('data', (chunk) => {
			raw += chunk;
			if (raw.length > 1024 * 1024) {
				reject(createError(413, 'Request body too large'));
				req.destroy();
			}
		});
		req.on('end', () => {
			if (!raw) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(raw));
			} catch (_error) {
				reject(createError(400, 'Invalid JSON body'));
			}
		});
		req.on('error', reject);
	});
}

function serveFile(filePath, res) {
	const ext = path.extname(filePath);
	const contentType = MIME_TYPES[ext] || 'application/octet-stream';
	fs.readFile(filePath, (error, data) => {
		if (error) {
			sendJson(res, 500, { ok: false, error: 'Failed to read static file' });
			return;
		}
		res.writeHead(200, { 'Content-Type': contentType });
		res.end(data);
	});
}

function sendJson(res, statusCode, payload) {
	res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(payload));
}

function setCorsHeaders(req, res) {
	// Public API endpoint: allow all origins (including file:// -> Origin: null)
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function createError(statusCode, message) {
	const error = new Error(message);
	error.statusCode = statusCode;
	return error;
}

function clampNumber(value, fallback, min, max) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, parsed));
}

function shouldRetry(error) {
	return !error.statusCode || error.statusCode >= 500;
}

function stripHtml(text) {
	return String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadText(response) {
	try {
		return await response.text();
	} catch (_error) {
		return '';
	}
}

function isRelevantCrossrefRecord(record, queryTokens) {
	if (!queryTokens.length) {
		return true;
	}
	const haystackTokens = tokenizeEnglish(`${record.title} ${record.abstract} ${(record.keywords || []).join(' ')}`);
	if (!haystackTokens.length) {
		return false;
	}
	const overlap = queryTokens.filter((token) => haystackTokens.includes(token)).length;
	return overlap >= Math.max(1, Math.floor(queryTokens.length * 0.2));
}

function tokenizeEnglish(text) {
	return Array.from(new Set(String(text || '')
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, ' ')
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 3)
		.filter((token) => !['the', 'and', 'for', 'with', 'using', 'study', 'analysis', 'model', 'models', 'based'].includes(token))));
}

async function searchArxivPapers(options) {
	const { translatedTopic, fromYear, untilYear, pageSize } = options;
	const queryTokens = tokenizeEnglish(translatedTopic);
	const maxResults = Math.min(ARXIV_CONFIG.maxResultsCap, Math.max(10, pageSize));
	const requestUrl = buildArxivUrl({ translatedTopic, fromYear, untilYear, maxResults });
	const xml = await fetchArxivXmlWithThrottle(requestUrl);
	const entries = parseArxivFeedXml(xml);
	const records = entries
		.map(normalizeArxivRecord)
		.filter(Boolean)
		.filter((record) => isRelevantCrossrefRecord(record, queryTokens));

	return {
		data: dedupeNormalizedRecords(records).slice(0, maxResults),
		meta: {
			totalFetched: records.length,
			requestUrl
		}
	};
}

function tokenizeForAnalysis(text) {
	const commonStopWords = new Set([
		'연구', '분석', '고찰', '효과', '영향', '중심', '기반', '활용', '개발', '탐색', '비교', '검증', '대한',
		'에서', '위한', '및', 'the', 'and', 'for', 'with', 'using', 'based', 'study', 'analysis', 'approach', 'model', 'models'
	]);

	return Array.from(new Set(String(text || '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, ' ')
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 2)
		.filter((token) => !commonStopWords.has(token))));
}

function overlapScoreForAnalysis(baseTokens, targetTokens) {
	if (!baseTokens.length || !targetTokens.length) {
		return 0;
	}
	const targetSet = new Set(targetTokens);
	const intersectionCount = baseTokens.filter((token) => targetSet.has(token)).length;
	const unionSize = new Set([...baseTokens, ...targetTokens]).size;
	return unionSize ? intersectionCount / unionSize : 0;
}

function includesLooseMatchForAnalysis(topic, record) {
	const topicTokens = tokenizeForAnalysis(topic);
	return topicTokens.some((token) =>
		String(record.title || '').toLowerCase().includes(token)
		|| String(record.abstract || '').toLowerCase().includes(token)
	);
}

function sortRecordsForAnalysis(records, sortOrder) {
	const sorted = [...records];
	if (sortOrder === 'citation') {
		sorted.sort((a, b) => (Number(b.citationCount || 0) - Number(a.citationCount || 0)) || (b.similarity - a.similarity));
	} else if (sortOrder === 'similarity') {
		sorted.sort((a, b) => (b.similarity - a.similarity) || ((Number(b.year || 0)) - Number(a.year || 0)));
	} else {
		sorted.sort((a, b) => ((Number(b.year || 0)) - Number(a.year || 0)) || (b.similarity - a.similarity));
	}
	return sorted;
}

function averageNumbers(values) {
	return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clampRange(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function buildAnalysisYearDistribution(records, minYear, maxYear) {
	const map = new Map();
	for (let year = minYear; year <= maxYear; year += 1) {
		map.set(year, 0);
	}
	records.forEach((record) => {
		if (record.year && map.has(record.year)) {
			map.set(record.year, map.get(record.year) + 1);
		}
	});
	return Array.from(map.entries()).map(([year, count]) => ({ year, count }));
}

function computeDistributionEntropy(counts) {
	const total = counts.reduce((sum, value) => sum + value, 0);
	if (!total) {
		return 0;
	}

	const probabilities = counts
		.filter((count) => count > 0)
		.map((count) => count / total);
	if (!probabilities.length) {
		return 0;
	}

	const entropy = -probabilities.reduce((sum, p) => sum + (p * Math.log2(p)), 0);
	const maxEntropy = Math.log2(probabilities.length);
	return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

function extractKeywordFrequencyForAnalysis(records, topicTokens) {
	const map = new Map();
	records.forEach((record) => {
		const tokens = (record.keywords && record.keywords.length)
			? record.keywords
			: tokenizeForAnalysis(`${record.title} ${record.abstract}`);
		tokens.forEach((token) => {
			const normalized = String(token).toLowerCase().trim();
			if (!normalized || normalized.length < 2 || topicTokens.includes(normalized)) {
				return;
			}
			map.set(normalized, (map.get(normalized) || 0) + 1);
		});
	});
	return Array.from(map.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 18)
		.map(([keyword, count]) => ({ keyword, count }));
}

function computeScarcityScore(records, topicTokens) {
	if (!records.length || !topicTokens.length) {
		return 0.7;
	}

	const tokenPresence = topicTokens.map((token) => {
		const count = records.filter((record) => {
			const haystack = `${record.title || ''} ${record.abstract || ''} ${(record.keywords || []).join(' ')}`.toLowerCase();
			return haystack.includes(token);
		}).length;
		return count / records.length;
	});

	const averagePresence = averageNumbers(tokenPresence);
	return clampRange(1 - averagePresence, 0.12, 0.94);
}

function computePmiKeywordRarity(keywords, papers) {
	const uniqueKeywords = dedupeStringArray(keywords || []).map((keyword) => String(keyword).toLowerCase()).filter(Boolean);
	if (uniqueKeywords.length < 2) {
		return 0.5;
	}

	const corpusSize = (papers.length || 0) + 1;
	const countWith = (keyword) => papers.filter((paper) => (paper.keywords || []).some((item) => String(item).toLowerCase().includes(keyword))).length + 1;
	const countWithBoth = (left, right) => papers.filter((paper) => {
		const lowerKeywords = (paper.keywords || []).map((item) => String(item).toLowerCase());
		return lowerKeywords.some((item) => item.includes(left)) && lowerKeywords.some((item) => item.includes(right));
	}).length + 1;

	const pmiValues = [];
	for (let i = 0; i < uniqueKeywords.length; i += 1) {
		for (let j = i + 1; j < uniqueKeywords.length; j += 1) {
			const P_i = countWith(uniqueKeywords[i]) / corpusSize;
			const P_j = countWith(uniqueKeywords[j]) / corpusSize;
			const P_ij = countWithBoth(uniqueKeywords[i], uniqueKeywords[j]) / corpusSize;
			pmiValues.push(Math.log2(P_ij / ((P_i * P_j) + 1e-9)));
		}
	}

	const meanPmi = averageNumbers(pmiValues);
	return Math.round(clampRange(1 / (1 + Math.exp(meanPmi)), 0, 1) * 10000) / 10000;
}

function rankSimilarPapersForAnalysis(papers, currentYear, topK) {
	const maxCitations = Math.max(1, ...papers.map((paper) => Number(paper.citationCount || 0)));
	return [...papers]
		.map((paper) => {
			const age = currentYear - Number(paper.year || currentYear);
			const recency = Math.max(0, 1 - (age / 20));
			const citeNorm = Math.log1p(Number(paper.citationCount || 0)) / Math.log1p(maxCitations + 1);
			const rankScore = (0.5 * Number(paper.similarity || 0)) + (0.25 * recency) + (0.25 * citeNorm);
			return { ...paper, rankScore: Math.round(rankScore * 10000) / 10000 };
		})
		.sort((a, b) => b.rankScore - a.rankScore)
		.slice(0, topK);
}

function classifyNovelty(score) {
	if (score >= 78) {
		return { label: '매우 참신함', tone: 'high', summary: '중복 연구 밀도가 낮고 희소성이 높습니다.' };
	}
	if (score >= 55) {
		return { label: '보통', tone: 'medium', summary: '선행연구는 있으나 차별화 가능한 구간입니다.' };
	}
	return { label: '기존 연구 다수', tone: 'low', summary: '유사 주제 연구가 많아 차별화 설계가 중요합니다.' };
}

function buildNoveltyRationale(options) {
	const {
		topAvg,
		recentShare,
		scarcityScore,
		highSimilarityShare,
		domesticCount,
		globalCount
	} = options;

	return [
		`유사도 평균 ${Math.round(topAvg * 100)}%로 ${topAvg < 0.3 ? '낮은 중복' : topAvg < 0.5 ? '중간 수준의 중복' : '높은 중복'} 상태입니다.`,
		`최근 5년 집중도 ${Math.round(recentShare * 100)}%로 ${recentShare < 0.35 ? '희소 분야 성격이 강합니다' : recentShare < 0.6 ? '완만한 증가 추세입니다' : '최근 연구 집중도가 높습니다'}.`,
		`희소성 지표 ${Math.round(scarcityScore * 100)}점으로 핵심 키워드 반복 빈도를 반영했습니다.`,
		`고유사도 문헌 비중은 ${Math.round(highSimilarityShare * 100)}%입니다.`,
		`국내 ${domesticCount}건, 해외 ${globalCount}건 문헌을 함께 반영했습니다.`
	];
}

function buildAnalysisInsight(options) {
	const {
		noveltyScore,
		recentShare,
		topAvg,
		domesticCount,
		globalCount,
		translatedTopic,
		keywordFreq,
		yearDist,
		highSimilarityShare,
		scarcityScore
	} = options;
	const peak = [...yearDist].sort((a, b) => b.count - a.count)[0];
	const keywords = keywordFreq.slice(0, 5).map((item) => item.keyword);
	const verdict = classifyNovelty(noveltyScore);

	return [
		verdict.summary,
		`상위 유사도 평균은 ${Math.round(topAvg * 100)}%입니다.`,
		`고유사도 문헌 비중은 ${Math.round(highSimilarityShare * 100)}%입니다.`,
		`최근 5년 집중도는 ${Math.round(recentShare * 100)}%입니다.`,
		`희소성 지표는 ${Math.round(scarcityScore * 100)}점입니다.`,
		`국내 ${domesticCount}건, 해외 ${globalCount}건 기준으로 분석했습니다.`,
		`해외 매핑 검색어는 "${translatedTopic}" 입니다.`,
		keywords.length ? `반복 키워드는 ${keywords.join(', ')}입니다.` : '',
		peak && peak.count > 0 ? `${peak.year}년에 발표량이 가장 높았습니다.` : ''
	].filter(Boolean).join(' ');
}

function buildGapAnalysisReport(options) {
	const {
		cfg,
		noveltyScore,
		confidence,
		topAvg,
		recentShare,
		highSimilarityShare,
		scarcityScore,
		creativityScore,
		queryPack,
		keywordFreq,
		yearDist,
		similarPapers,
		translatedTopic,
		matchCount
	} = options;

	const leadKeywords = (keywordFreq || []).slice(0, 4).map((item) => item.keyword).filter(Boolean);
	const quietYears = (yearDist || []).filter((item) => Number(item.count || 0) <= 1).map((item) => item.year);
	const recentPeak = [...(yearDist || [])].sort((a, b) => b.count - a.count)[0];
	const whitespaceLevel = noveltyScore >= 78 ? 'high' : noveltyScore >= 55 ? 'medium' : 'low';
	const overlapLevel = topAvg >= 0.5 ? 'dense' : topAvg >= 0.28 ? 'moderate' : 'light';
	const opportunitySignals = [];
	const riskFlags = [];
	const recommendedAngles = [];

	if (scarcityScore >= 0.65) {
		opportunitySignals.push('핵심 키워드 조합이 기존 코퍼스에서 반복적으로 소비되지 않아 개념적 공백이 존재합니다.');
	}
	if (recentShare < 0.35) {
		opportunitySignals.push('최근 3~5년 발표 집중도가 낮아 후속 연구 파이프라인이 아직 포화되지 않았습니다.');
	}
	if (creativityScore >= 0.58) {
		opportunitySignals.push('키워드 조합의 연결 강도가 낮아 융합형 연구 질문으로 재구성할 여지가 큽니다.');
	}
	if (highSimilarityShare >= 0.45 || topAvg >= 0.45) {
		riskFlags.push('상위 유사 문헌 밀도가 높아 단순 반복 설계로는 차별성이 약할 수 있습니다.');
	}
	if (confidence < 0.45) {
		riskFlags.push('검색 신뢰도가 낮아 범위 확대 또는 세부 키워드 보강이 필요합니다.');
	}
	if (matchCount >= 25 && recentPeak && recentPeak.count >= 5) {
		riskFlags.push(`최근 발표가 ${recentPeak.year}년 전후로 집중되어 있어 후발 연구와의 비교 프레임을 정교화해야 합니다.`);
	}

	recommendedAngles.push(`${cfg.topic} 주제를 ${leadKeywords.length ? leadKeywords.join(' · ') : '핵심 변수 재정의'} 중심으로 세분화해 하위 집단 또는 맥락 조건을 명시합니다.`);
	if (quietYears.length) {
		recommendedAngles.push(`발표 공백이 보이는 ${quietYears.slice(0, 2).join(', ')}년 인접 구간을 활용해 시계열 갭 또는 사후 변화 효과를 겨냥합니다.`);
	}
	if ((queryPack?.coreKeywordsEn || []).length) {
		recommendedAngles.push(`영문 검색축은 ${queryPack.coreKeywordsEn.slice(0, 3).join(', ')} 중심으로 유지하되 대상 집단·환경 변수를 추가해 검색 정밀도를 높입니다.`);
	}

	return {
		whitespaceLevel,
		overlapLevel,
		queryFocus: translatedTopic,
		dominantKeywords: leadKeywords,
		underExploredYears: quietYears.slice(0, 4),
		overview: whitespaceLevel === 'high'
			? '코퍼스 중복이 높지 않고 시계열 포화도도 낮아 연구 공백을 공략하기 유리한 상태입니다.'
			: whitespaceLevel === 'medium'
				? '선행연구는 존재하지만 특정 집단, 맥락, 측정 변수를 좁히면 의미 있는 차별화가 가능합니다.'
				: '핵심 문제 정의만으로는 중복 가능성이 높아 대상, 방법, 맥락 축을 더 선명하게 재설계해야 합니다.',
		opportunitySignals: opportunitySignals.length ? opportunitySignals : ['현재 코퍼스 기준으로는 명확한 공백 신호가 제한적이므로 세부 조건 변수를 추가하는 것이 안전합니다.'],
		riskFlags: riskFlags.length ? riskFlags : ['현 수준에서는 구조적 위험 신호가 크지 않지만, 표본·맥락 차별화는 여전히 필요합니다.'],
		recommendedAngles: recommendedAngles.slice(0, 3),
		similarPaperSnapshot: (similarPapers || []).slice(0, 3).map((paper) => ({
			title: paper.title,
			year: paper.year,
			journal: paper.journal,
			similarity: paper.similarity,
			rankScore: paper.rankScore
		}))
	};
}

function buildSpecReportNarrative(options) {
	const {
		cfg,
		noveltyScore,
		confidence,
		verdict,
		translatedTopic,
		topAvg,
		recentShare,
		highSimilarityShare,
		gapAnalysis,
		keywordFreq,
		matchCount
	} = options;

	const dominantKeywords = (keywordFreq || []).slice(0, 4).map((item) => item.keyword).filter(Boolean);
	const confidenceLabel = confidence >= 0.75 ? '높음' : confidence >= 0.45 ? '보통' : '낮음';

	return {
		executiveSummary: `${cfg.topic} 주제는 현재 ${verdict.label} 구간에 위치하며, 참신성 지수는 ${Math.round(noveltyScore)}점입니다. 검색 신뢰도는 ${confidenceLabel}(${Math.round(confidence * 100)}%)이고, 상위 유사 문헌 평균 중복도는 ${Math.round(topAvg * 100)}%입니다.`,
		gapStatement: `${gapAnalysis.overview} 특히 ${gapAnalysis.dominantKeywords && gapAnalysis.dominantKeywords.length ? gapAnalysis.dominantKeywords.join(', ') : translatedTopic} 축에서 반복되는 선행연구 프레임과 차별화할 필요가 있습니다.`,
		contributionHypothesis: gapAnalysis.recommendedAngles[0] || `${cfg.topic} 주제를 대상 집단 또는 적용 맥락 기준으로 재정의하면 선행연구와의 구분선이 더 선명해질 수 있습니다.`,
		searchStrategyNote: `현재 검색은 "${translatedTopic}" 축으로 확장되었으며, 총 ${matchCount}건의 직접 비교 문헌을 기준으로 ${Math.round(recentShare * 100)}%가 최근 발표군에 속합니다.`,
		riskAssessment: highSimilarityShare >= 0.45
			? '상위 유사 문헌 비중이 높아 연구 질문을 더 좁게 정의하지 않으면 차별성이 빠르게 약화될 수 있습니다.'
			: '유사 문헌 비중이 과도하게 높지 않아 방법론·대상 설계 차별화가 실질적 기여로 이어질 가능성이 있습니다.',
		recommendedAbstractSentence: dominantKeywords.length
			? `${cfg.topic}를 ${dominantKeywords.slice(0, 2).join(' 및 ')} 관점에서 재구성하여 기존 연구가 충분히 다루지 못한 맥락적 메커니즘을 검증한다.`
			: `${cfg.topic}의 맥락적 차별 요인을 중심으로 기존 선행연구와 구분되는 실증 설계를 제안한다.`
	};
}

function buildArxivUrl(options) {
	const { translatedTopic, fromYear, untilYear, maxResults } = options;
	const query = `all:${translatedTopic} AND submittedDate:[${fromYear}01010000 TO ${untilYear}12312359]`;
	const url = new URL(ARXIV_CONFIG.baseUrl);
	url.searchParams.set('search_query', query);
	url.searchParams.set('start', '0');
	url.searchParams.set('max_results', String(maxResults));
	url.searchParams.set('sortBy', 'submittedDate');
	url.searchParams.set('sortOrder', 'descending');
	return url.toString();
}

async function fetchArxivXmlWithThrottle(url) {
	const now = Date.now();
	const waitMs = Math.max(0, (lastArxivRequestAt + ARXIV_CONFIG.minIntervalMs) - now);
	if (waitMs > 0) {
		await wait(waitMs);
	}
	const xml = await fetchTextWithRetries(url, {
		headers: {
			Accept: 'application/atom+xml',
			'User-Agent': `global-paper-analyzer/1.0 (mailto:${CROSSREF_MAILTO})`
		},
		errorContext: 'arXiv'
	});
	lastArxivRequestAt = Date.now();
	return xml;
}

async function fetchTextWithRetries(url, options) {
	const { headers = {}, errorContext = 'Request' } = options || {};
	let lastError = null;

	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(25000)
			});

			if (response.status === 429) {
				throw createError(429, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
			}
			if (response.status >= 500) {
				throw createError(response.status, '외부 데이터 서버가 일시적으로 불안정합니다. 잠시 후 다시 시도하세요.');
			}
			if (!response.ok) {
				const message = await safeReadText(response);
				throw createError(response.status, `${errorContext} 요청 실패: ${message || response.statusText}`);
			}

			return response.text();
		} catch (error) {
			lastError = error;
			if (!shouldRetry(error) || attempt === 2) {
				throw error;
			}
			await wait(500 * (attempt + 1));
		}
	}

	throw lastError || createError(500, `${errorContext} failed`);
}

function parseArxivFeedXml(xml) {
	const entries = [];
	const blocks = String(xml || '').match(/<entry>([\s\S]*?)<\/entry>/g) || [];

	for (const block of blocks) {
		const title = decodeXmlEntities(extractXmlTag(block, 'title'));
		const summary = decodeXmlEntities(extractXmlTag(block, 'summary'));
		const published = extractXmlTag(block, 'published');
		const id = decodeXmlEntities(extractXmlTag(block, 'id'));
		const authors = Array.from(block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g))
			.map((match) => decodeXmlEntities(match[1]).trim())
			.filter(Boolean);
		const categories = Array.from(block.matchAll(/<category[^>]*term="([^"]+)"/g))
			.map((match) => decodeXmlEntities(match[1]).trim())
			.filter(Boolean);

		let htmlLink = '';
		for (const linkMatch of block.matchAll(/<link\s+([^>]*?)\/?>(?:<\/link>)?/g)) {
			const attrs = linkMatch[1] || '';
			const href = extractXmlAttribute(attrs, 'href');
			const rel = extractXmlAttribute(attrs, 'rel');
			const type = extractXmlAttribute(attrs, 'type');
			if (href && rel === 'alternate' && (!type || type === 'text/html')) {
				htmlLink = href;
				break;
			}
		}

		entries.push({
			title,
			summary,
			published,
			id,
			authors,
			categories,
			htmlLink: htmlLink || id
		});
	}

	return entries;
}

function normalizeArxivRecord(entry) {
	if (!entry || !entry.title) {
		return null;
	}

	const firstCategory = entry.categories && entry.categories[0] ? entry.categories[0] : '';
	return {
		title: String(entry.title).trim(),
		abstract: stripHtml(String(entry.summary || '').trim()),
		keywords: Array.isArray(entry.categories) ? entry.categories : [],
		year: normalizeYear(entry.published),
		author: Array.isArray(entry.authors) && entry.authors.length ? entry.authors.join(', ') : 'Author unknown',
		type: 'Pre-print',
		field: firstCategory || 'Preprint',
		journal: 'Preprint Archive',
		citationCount: 0,
		doi: '',
		url: String(entry.htmlLink || '').trim(),
		source: 'Pre-print',
		language: 'en',
		openalexId: '',
		arxivId: normalizeArxivIdentifier(entry.id || entry.htmlLink || '')
	};
}

function extractXmlTag(block, tagName) {
	const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
	const match = String(block || '').match(regex);
	return match ? match[1].replace(/\s+/g, ' ').trim() : '';
}

function extractXmlAttribute(attrText, attributeName) {
	const regex = new RegExp(`${attributeName}="([^"]*)"`, 'i');
	const match = String(attrText || '').match(regex);
	return match ? decodeXmlEntities(match[1]).trim() : '';
}

function decodeXmlEntities(value) {
	return String(value || '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}