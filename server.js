require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_FILE = path.join(__dirname, 'journal.html');
const CROSSREF_MAILTO = 'huhuhu1013@naver.com';
const DEFAULT_ALLOWED_ORIGINS = [
	'http://localhost:3000',
	'http://127.0.0.1:3000',
	'https://jun-kim1.github.io',
	'https://journal-49pm.onrender.com'
];
const ALLOWED_ORIGINS = dedupeStringArray([
	...DEFAULT_ALLOWED_ORIGINS,
	...String(process.env.ALLOWED_ORIGINS || '')
		.split(',')
		.map((origin) => String(origin || '').trim())
		.filter(Boolean)
]);
const CORS_ALLOW_ALL = String(process.env.CORS_ALLOW_ALL || '').toLowerCase() === 'true';
const {
	KCI_CONFIG,
	CROSSREF_CONFIG,
	PAPER_TYPE_MAP,
	ENTITY_SUBSTITUTION_MAP,
	CONCEPT_SYNONYM_MAP
} = require('./constants');
const {
	buildAnalysisReport
} = require('./scoring');

const ARXIV_CONFIG = {
	baseUrl: 'https://export.arxiv.org/api/query',
	minIntervalMs: 3000,
	maxResultsCap: 150
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
	baseUrl: process.env.NANET_BASE_URL || 'https://openapi.nanet.go.kr/search/v1/article',
	legacyBaseUrl: process.env.NANET_LEGACY_BASE_URL || 'https://www.nanet.go.kr/search/openApi/search.do',
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

const TREND_KEYWORDS = [
	{ topic: '생성형 AI', globalQuery: 'Large Language Models', domesticQuery: '생성형 인공지능' },
	{ topic: '양자 컴퓨팅', globalQuery: 'Quantum Computing', domesticQuery: '양자 컴퓨팅' },
	{ topic: '기후변화 모델링', globalQuery: 'Climate Change Modeling', domesticQuery: '기후변화 모델링' },
	{ topic: '유전자 편집', globalQuery: 'CRISPR Gene Editing', domesticQuery: '유전자 편집' },
	{ topic: '멀티모달 AI', globalQuery: 'Multimodal AI', domesticQuery: '멀티모달 인공지능' },
	{ topic: '트랜스포머 아키텍처', globalQuery: 'Transformer Architecture', domesticQuery: '트랜스포머' },
	{ topic: '연합학습', globalQuery: 'Federated Learning', domesticQuery: '연합학습' },
	{ topic: '확산모델', globalQuery: 'Diffusion Models', domesticQuery: '확산 모델' }
];
const TREND_CACHE_TTL_MS = 30 * 60 * 1000;
const TREND_MIN_GROWTH_RATE = 5;
const TREND_MIN_RECENT_COUNT = 1;
const TREND_MIN_SOURCE_SUCCESS = 2;
let trendingTopicsCache = {
	expiresAt: 0,
	updatedAt: 0,
	data: [],
	meta: {}
};

let lastArxivRequestAt = 0;
const dynamicExpansionCache = new Map();
const ARXIV_XML_PARSER = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '',
	removeNSPrefix: true,
	parseTagValue: false,
	trimValues: true,
	processEntities: true
});

const server = http.createServer(async (req, res) => {
	setCorsHeaders(req, res);
	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}
	const requestUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
	console.log(`[${new Date().toISOString()}] ${req.method} ${requestUrl.pathname}`);
	try {
		if (req.method === 'GET' && !requestUrl.pathname.startsWith('/api/')) {
			const relativePath = requestUrl.pathname.replace(/^\/+/, '');
			const requestedFile = path.join(__dirname, relativePath || 'journal.html');
			if (relativePath && fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
				serveFile(requestedFile, res);
				return;
			}
			// SPA fallback: unknown GET routes should still return the main app shell.
			serveFile(STATIC_FILE, res);
			return;
		}

		if (req.method === 'POST' && requestUrl.pathname === '/api/analyze') {
			console.log('[analyze] Reading JSON body...');
			const body = await readJsonBody(req);
			console.log('[analyze] Body received:', Object.keys(body));
			console.log('[analyze] Topic:', body.topic);
			console.log('[analyze] PaperTypes:', body.paperTypes);
			console.log('[analyze] GlobalTypes:', body.globalTypes);
			console.log('[analyze] Starting analysis...');
			try {
				const result = await analyzeTopicSources(body);
				console.log('[analyze] Result data count:', result.data ? result.data.length : 0);
				console.log('[analyze] Result matchCount:', result.analysis ? result.analysis.matchCount : 0);
				console.log('[analyze] Result similarPapers count:', result.analysis && result.analysis.similarPapers ? result.analysis.similarPapers.length : 0);
				console.log('[analyze] Analysis complete, sending response...');
				sendJson(res, 200, { ok: true, ...result });
			} catch (error) {
				console.error('[analyze] ERROR:', error.message);
				throw error;
			}
			return;
		}

		if (req.method === 'GET' && requestUrl.pathname === '/api/trending-topics') {
			const topN = clampNumber(Number(requestUrl.searchParams.get('topN') || 4), 4, 1, 8);
			const forceRefresh = String(requestUrl.searchParams.get('refresh') || '').toLowerCase() === 'true';
			const trendResult = await getTrendingTopics({ topN, forceRefresh });
			const basisText = '최근 30일 트렌드 지표';
			sendJson(res, 200, {
				ok: true,
				data: trendResult.data,
				meta: {
					...trendResult.meta,
					basis: basisText,
					cached: !forceRefresh && Date.now() < trendingTopicsCache.expiresAt
				}
			});
			return;
		}

		if (req.method === 'GET' && requestUrl.pathname === '/api/trending-topic-papers') {
			const topic = String(requestUrl.searchParams.get('topic') || '').trim();
			if (!topic) {
				throw createError(400, 'topic 파라미터를 입력하세요.');
			}

			const limit = clampNumber(Number(requestUrl.searchParams.get('limit') || 20), 20, 5, 40);
			const rangeYears = clampNumber(Number(requestUrl.searchParams.get('rangeYears') || 5), 5, 3, 15);

			const analyzed = await analyzeTopicSources({
				topic,
				rangeYears,
				pageSize: 120,
				recentWeight: 1,
				similarityThreshold: 0.5,
				sortOrder: 'latest',
				paperTypes: ['학술지', '석사', '박사'],
				globalTypes: ['journal', 'preprint']
			});

			const papers = Array.isArray(analyzed?.data) ? analyzed.data : [];
			const sorted = [...papers].sort((a, b) => {
				const yearGap = (Number(b?.year || 0) - Number(a?.year || 0));
				if (yearGap !== 0) return yearGap;
				return Number(b?.citationCount || 0) - Number(a?.citationCount || 0);
			});

			sendJson(res, 200, {
				ok: true,
				topic,
				count: papers.length,
				data: sorted.slice(0, limit)
			});
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
	console.log(`[startup] build=2026-05-09-nanet-v5-dedupefix nanetBaseUrl=${NANET_CONFIG.baseUrl}`);
	console.log(`[startup] kciKeyConfigured=${Boolean(String(KCI_CONFIG.defaultServiceKey || '').trim())} nanetKeyConfigured=${Boolean(String(NANET_CONFIG.apiKey || '').trim())}`);
});

async function analyzeTopicSources(payload) {
	const topic = String(payload.topic || '').trim();
	if (!topic) {
		throw createError(400, '검색할 논문 주제를 입력하세요.');
	}

	const includeKci = true; // 항상 모든 소스 수집
	const includeCrossref = true;
	const globalTypes = ['journal', 'preprint'];
	const includePreprint = true;

	const rangeYears = clampNumber(payload.rangeYears, 5, 3, 15);
	const currentYear = new Date().getFullYear();
	const fromYear = currentYear - rangeYears + 1;
	const untilYear = currentYear;
	const pageSize = clampNumber(payload.pageSize, 160, 20, 400);
	const field = String(payload.field || 'all');
	
	// 기본값 설정: paperTypes와 globalTypes가 비어있으면 기본값 사용
	let paperTypes = Array.isArray(payload.paperTypes) && payload.paperTypes.length ? payload.paperTypes : ['학술지'];
	let globalTypesResult = globalTypes && globalTypes.length ? globalTypes : ['journal'];
	
	const serviceKey = KCI_CONFIG.defaultServiceKey;
	const serviceKeyMode = String(payload.serviceKeyMode || 'auto');
	const nanetApiKey = NANET_CONFIG.apiKey;
	const openAlexApiKey = OPENALEX_CONFIG.apiKey;
	const openAlexMailto = OPENALEX_CONFIG.mailto;

	console.log('[analyze] Final paperTypes:', paperTypes);
	console.log('[analyze] Final globalTypes:', globalTypesResult);

	const queryPack = await buildQueryPack(topic);
	const translatedTopic = queryPack.translatedTopic;
	const globalQueryTopic = queryPack.globalQueryTopic;
	const globalQueryCandidates = dedupeStringArray([
		queryPack.primaryQueryEn,
		queryPack.globalQueryTopic,
		...queryPack.expandedQueries,
		...buildScenarioQueryVariants(queryPack)
	]).filter(Boolean).slice(0, 8);

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

	const semanticScholarTask = searchSemanticScholarPapers({
		topic,
		pageSize: Math.max(20, Math.round(pageSize * 0.3)),
		fromYear,
		untilYear
	});

	const openAlexKoTask = searchOpenAlexKoreanPapers({
		topic,
		fromYear,
		untilYear,
		pageSize: Math.max(20, Math.round(pageSize * 0.25)),
		apiKey: openAlexApiKey,
		mailto: openAlexMailto
	});

	const settled = await Promise.allSettled([kciTask, nanetTask, openAlexTask, crossrefTask, arxivTask, semanticScholarTask, openAlexKoTask]);

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
	const semanticScholarResult = settled[5].status === 'fulfilled'
		? settled[5].value
		: { data: [], meta: { error: settled[5].reason?.message } };
	const openAlexKoResult = settled[6].status === 'fulfilled'
		? settled[6].value
		: { data: [], meta: { error: settled[6].reason?.message } };
	console.log(`[source-summary] KCI meta=${JSON.stringify(kciResult?.meta || {})}`);
	console.log(`[source-summary] NANET meta=${JSON.stringify(nanetResult?.meta || {})}`);
	console.log(`[source-summary] SemanticScholar: ${semanticScholarResult.data?.length || 0}건 (Korean=${(semanticScholarResult.data || []).filter((p) => p.language === 'ko').length}건)`);
	console.log(`[source-summary] OpenAlexKO: ${openAlexKoResult.data?.length || 0}건`);

	const kciSkipReason = String(kciResult?.meta?.reason || '');
	const nanetSkipReason = String(nanetResult?.meta?.reason || '');
	const kciKeyConfigured = Boolean(String(serviceKey || '').trim());
	const nanetKeyConfigured = Boolean(String(nanetApiKey || '').trim());

	// Semantic Scholar & OpenAlex-KO가 한국 논문을 보완
	const domesticFromSS = (semanticScholarResult.data || []).filter((p) => p.language === 'ko');
	const domesticFromOAKo = openAlexKoResult.data || [];

	console.log(`[sources] KCI: ${kciResult.data ? kciResult.data.length : 0}, NANET: ${nanetResult.data ? nanetResult.data.length : 0}, SemanticScholar-KO: ${domesticFromSS.length}, OpenAlexKO: ${domesticFromOAKo.length}, OpenAlex: ${openAlexResult.data ? openAlexResult.data.length : 0}, Crossref: ${crossrefResult.data ? crossrefResult.data.length : 0}, arXiv: ${arxivResult.data ? arxivResult.data.length : 0}`);
	if (warnings.length > 0) {
		console.log('[sources] Warnings:', warnings);
	}
	const mergedDomestic = mergeDomesticSources(
		[...(kciResult.data || []), ...(nanetResult.data || []), ...domesticFromSS, ...domesticFromOAKo],
		[]
	);
	const ssGlobal = (semanticScholarResult.data || []).filter((p) => p.language !== 'ko');
	const mergedGlobal = mergeGlobalSources(openAlexResult.data, crossrefResult.data, [...(arxivResult.data || []), ...ssGlobal]);
	let merged = improvedDedupeByIdentifiers([...mergedDomestic, ...mergedGlobal]);

	if (merged.length < Math.max(12, Math.round(pageSize * 0.08))) {
		const recoveryQueries = dedupeStringArray([
			translatedTopic,
			globalQueryTopic,
			queryPack.primaryQueryEn,
			...queryPack.expandedQueries,
			...buildScenarioQueryVariants(queryPack),
			topic
		]).filter(Boolean).slice(0, 8);
		try {
			const [openAlexRecovery, crossrefRecovery, arxivRecovery] = await Promise.all([
				searchAcrossQueryVariants(recoveryQueries, (query) => searchOpenAlexWorks({
					topic,
					translatedTopic: query,
					fromYear,
					untilYear,
					globalTypes: globalTypesResult,
					pageSize: Math.max(120, pageSize),
					apiKey: openAlexApiKey,
					mailto: openAlexMailto,
					strictRelevance: false
				}), Math.max(120, pageSize)),
				searchAcrossQueryVariants(recoveryQueries, (query) => searchCrossrefPapers({
					topic,
					translatedTopic: query,
					fromYear,
					untilYear,
					pageSize: Math.max(100, Math.round(pageSize * 0.7)),
					globalTypes: globalTypesResult,
					strictRelevance: false
				}), Math.max(100, Math.round(pageSize * 0.7))),
				searchAcrossQueryVariants(recoveryQueries, (query) => searchArxivPapers({
					topic,
					translatedTopic: query,
					fromYear,
					untilYear,
					pageSize: Math.max(40, Math.round(pageSize * 0.3)),
					strictRelevance: false
				}), Math.max(40, Math.round(pageSize * 0.3)))
			]);
			const recoveryMerged = improvedDedupeByIdentifiers([
				...(openAlexRecovery.data || []),
				...(crossrefRecovery.data || []),
				...(arxivRecovery.data || [])
			]);
			if (recoveryMerged.length > 0) {
				warnings.push('일부 API 응답 저하로 글로벌 복구 검색을 적용했습니다.');
				merged = improvedDedupeByIdentifiers([...merged, ...recoveryMerged]);
			}
		} catch (recoveryError) {
			warnings.push(`복구 검색 시도 실패: ${String(recoveryError?.message || recoveryError || 'unknown')}`);
		}
	}

	const sourceResults = {
		kci: kciResult,
		nanet: nanetResult,
		openalex: openAlexResult,
		crossref: crossrefResult,
		preprint: arxivResult
	};
	const sourceFailureFlags = Object.fromEntries(
		Object.entries(sourceResults).map(([name, result]) => [name, isSourceFetchFailure(result)])
	);
	const failedSources = Object.entries(sourceFailureFlags)
		.filter(([, failed]) => failed)
		.map(([name]) => name);

	// 도메인 필수 키워드 감지 및 필터링 (요구사항 2, 3)
	const domainMustKeywords = buildDomainMustKeywords(queryPack);
	let domainFiltered = filterByDomainRelevance(merged, domainMustKeywords);

	const minDesiredResults = Math.min(40, Math.max(16, Math.round(pageSize * 0.2)));
	if (domainFiltered.length < minDesiredResults) {
		const relevanceRanked = rankByQueryAffinity(merged, queryPack, domainMustKeywords);
		domainFiltered = relevanceRanked.slice(0, pageSize);
		if (merged.length > 0 && domainFiltered.length > 0) {
			warnings.push('유사 주제 확장 검색을 적용해 관련 논문 후보를 보강했습니다.');
		}
	}

	if (domainFiltered.length === 0 && merged.length === 0 && failedSources.length) {
		const failureDetail = failedSources
			.map((name) => {
				const reason = sourceResults[name] && sourceResults[name].meta ? String(sourceResults[name].meta.reason || '') : '';
				return reason ? `${name}:${reason}` : name;
			})
			.join(' | ')
			.slice(0, 600);

		throw createError(
			502,
			`논문 DB 연결 실패로 분석을 중단했습니다. 잠시 후 다시 시도해주세요. 실패 소스: ${failedSources.join(', ')}${failureDetail ? ` (${failureDetail})` : ''}`
		);
	}

	const analysis = buildAnalysisReport({
		topic,
		rangeYears,
		field,
		pageSize,
		recentWeight: clampNumber(payload.recentWeight, 1, 0.5, 1.5),
		similarityThreshold: clampNumber(payload.similarityThreshold, 0.65, 0.5, 0.9),
		includeKci,
		includeCrossref,
		includePreprint,
		paperTypes: paperTypes,
		globalTypes: globalTypesResult,
		sortOrder: String(payload.sortOrder || 'latest')
	}, domainFiltered, {
		queryPack,
		translatedTopic,
		globalQueryTopic,
		domesticCount: mergedDomestic.length,
		globalCount: mergedGlobal.length,
		warnings
	});

	return {
		data: domainFiltered,
		analysis,
		meta: {
			warnings,
			diagnostics: {
				sourceFailure: {
					failedSources,
					hasCriticalFailure: failedSources.length > 0
				},
				keysConfigured: {
					kci: kciKeyConfigured,
					nanet: nanetKeyConfigured,
					openalex: Boolean(String(openAlexApiKey || '').trim())
				},
				sourceSkipReasons: {
					kci: kciSkipReason,
					nanet: nanetSkipReason,
					openalex: String(openAlexResult?.meta?.reason || ''),
					crossref: String(crossrefResult?.meta?.reason || ''),
					preprint: String(arxivResult?.meta?.reason || '')
				}
			},
			translatedTopic,
			globalQueryTopic,
			queryPack,
			domainMustKeywords,
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
			semanticScholarKoCount: domesticFromSS.length,
			openAlexKoCount: domesticFromOAKo.length,
			globalCount: mergedGlobal.length,
			openAlexCount: openAlexResult.data.length,
			crossrefCount: crossrefResult.data.length,
			preprintCount: arxivResult.data.length,
			totalCount: domainFiltered.length,
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

function isExpectedSourceSkipReason(reason) {
	const text = String(reason || '').toLowerCase();
	if (!text) return false;
	return (
		text.includes('disabled by user')
		|| text.includes('api key not configured')
		|| text.includes('no kci service key')
		|| text.includes('no nanet api key')
		|| text.includes('no global type selected')
		|| text.includes('no crossref-compatible type selected')
		|| text.includes('no query variants available')
	);
}

function isSourceFetchFailure(result) {
	const dataCount = Array.isArray(result && result.data) ? result.data.length : 0;
	if (dataCount > 0) {
		return false;
	}

	const meta = (result && typeof result.meta === 'object') ? result.meta : {};
	const reason = String(meta.reason || '').trim();
	const reasons = Array.isArray(meta.reasons) ? meta.reasons : [];
	const queries = Array.isArray(meta.queries) ? meta.queries : [];

	if (meta.skipped && reason && !isExpectedSourceSkipReason(reason)) {
		return true;
	}

	if (reasons.length && (!queries.length || reasons.length >= queries.length)) {
		return true;
	}

	return false;
}

function formatDateYmd(date) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function formatArxivDate(date, endOfDay = false) {
	const ymd = formatDateYmd(date).replace(/-/g, '');
	return `${ymd}${endOfDay ? '2359' : '0000'}`;
}

function getTrendDateRanges() {
	const today = new Date();
	const recentEnd = new Date(today);
	const recentStart = new Date(today);
	recentStart.setDate(recentStart.getDate() - 30);

	const prevEnd = new Date(recentStart);
	prevEnd.setDate(prevEnd.getDate() - 1);
	const prevStart = new Date(prevEnd);
	prevStart.setDate(prevStart.getDate() - 30);

	return {
		recentStart,
		recentEnd,
		prevStart,
		prevEnd,
		recentStartYmd: formatDateYmd(recentStart),
		recentEndYmd: formatDateYmd(recentEnd),
		prevStartYmd: formatDateYmd(prevStart),
		prevEndYmd: formatDateYmd(prevEnd)
	};
}

function buildScenarioQueryVariants(queryPack) {
	const baseQuery = String(queryPack?.primaryQueryEn || queryPack?.globalQueryTopic || '').trim();
	if (!baseQuery) {
		return [];
	}

	const topicKo = String(queryPack?.primaryQueryKo || '').trim();
	const hasSelfEfficacy = /self-efficacy|self efficacy|자기효능감/i.test(`${baseQuery} ${topicKo}`);
	const hasGenerativeAi = /generative|llm|large language model|chatgpt|생성형|인공지능|ai/i.test(`${baseQuery} ${topicKo}`);
	if (!hasSelfEfficacy && !hasGenerativeAi) {
		return [];
	}

	const scenarios = [
		'generative ai self-efficacy effects academic',      // general — no person-type bias
		'llm self-efficacy student learning',                // student context
		'programmer self-efficacy generative ai',
		'developer self-efficacy large language model'
	];

	// Use scenarios as standalone queries (not prepended with full base query).
	// Prepending the long base query makes isRelevantCrossrefRecord threshold too high,
	// filtering out valid student/programmer self-efficacy papers.
	return dedupeStringArray(scenarios).slice(0, 4);
}

function rankByQueryAffinity(papers, queryPack, mustKeywordsByCategory) {
	if (!Array.isArray(papers) || !papers.length) {
		return [];
	}

	const queryTokens = dedupeStringArray([
		...tokenizeEnglish(queryPack?.primaryQueryEn || ''),
		...tokenizeEnglish(queryPack?.globalQueryTopic || ''),
		...(Array.isArray(queryPack?.coreKeywordsKo) ? queryPack.coreKeywordsKo : []),
		...(Array.isArray(queryPack?.coreKeywordsEn) ? queryPack.coreKeywordsEn : [])
	]).filter((token) => String(token || '').trim().length >= 2);
	const mustTokens = dedupeStringArray(Object.values(mustKeywordsByCategory || {}).flat());
	const highIntentTokens = new Set([
		'self-efficacy', 'self efficacy', '자기효능감',
		'programmer', 'developer', 'software engineer', '프로그래머', '개발자',
		'artist', 'creator', 'creative', '예술가', '창작자',
		'generative', 'llm', 'chatgpt', '생성형'
	]);

	const scored = papers.map((paper) => {
		const text = [
			paper.title || '',
			paper.abstract || '',
			...(Array.isArray(paper.keywords) ? paper.keywords : [])
		].join(' ').toLowerCase();

		let score = 0;
		for (const tokenRaw of queryTokens) {
			const token = String(tokenRaw || '').toLowerCase().trim();
			if (!token) continue;
			if (text.includes(token)) {
				score += highIntentTokens.has(token) ? 2.4 : 1.0;
			}
		}

		for (const tokenRaw of mustTokens) {
			const token = String(tokenRaw || '').toLowerCase().trim();
			if (!token) continue;
			if (text.includes(token)) {
				score += highIntentTokens.has(token) ? 1.8 : 0.8;
			}
		}

		if ((paper.source === 'KCI' || paper.source === 'NANET') && /[가-힣]/.test(`${paper.title || ''} ${paper.abstract || ''}`)) {
			score += 1.2;
		}

		score += Math.min((Number(paper.citationCount || 0) || 0) / 200, 0.6);

		// Per-category penalty: if paper is missing ANY must-keyword category entirely,
		// apply 0.3x multiplier per missing category.
		// This prevents generative-AI-only papers from outranking self-efficacy papers
		// when the query requires both concepts.
		for (const [, categoryKeywords] of Object.entries(mustKeywordsByCategory || {})) {
			const hasCategoryMatch = categoryKeywords.some((kw) => {
				const k = String(kw || '').toLowerCase().trim();
				return k && text.includes(k);
			});
			if (!hasCategoryMatch) {
				score *= 0.3;
			}
		}

		return { paper, score };
	});

	scored.sort((a, b) => b.score - a.score);
	const strongMatches = scored.filter((item) => item.score >= 1.0).map((item) => item.paper);
	if (strongMatches.length) {
		const minKeep = Math.min(40, papers.length);
		if (strongMatches.length >= minKeep) {
			return strongMatches;
		}
		const rankedAll = scored.map((item) => item.paper);
		return dedupeNormalizedRecords([...strongMatches, ...rankedAll]).slice(0, minKeep);
	}

	return scored.map((item) => item.paper);
}

function computeGrowthRate(recentTotal, prevTotal) {
	if (prevTotal <= 0) {
		return recentTotal > 0 ? 100 : 0;
	}
	return Math.round((((recentTotal - prevTotal) / prevTotal) * 100) * 10) / 10;
}

function parseIntegerCount(value) {
	const num = Number(value);
	if (!Number.isFinite(num) || num < 0) {
		return 0;
	}
	return Math.round(num);
}

async function fetchCrossrefTrendCount(keyword, fromDate, toDate) {
	const url = new URL(`${CROSSREF_CONFIG.baseUrl}${CROSSREF_CONFIG.worksPath}`);
	url.searchParams.set('query', keyword);
	url.searchParams.set('filter', `from-pub-date:${fromDate},until-pub-date:${toDate}`);
	url.searchParams.set('rows', '0');
	url.searchParams.set('mailto', CROSSREF_MAILTO);

	const json = await fetchJsonWithRetries(url.toString(), {
		headers: {
			Accept: 'application/json',
			'User-Agent': `global-paper-analyzer/1.0 (mailto:${CROSSREF_MAILTO})`
		},
		errorContext: 'Crossref trend'
	});

	return parseIntegerCount(json?.message?.['total-results']);
}

async function fetchArxivTrendCount(keyword, fromDate, toDate) {
	const fromArxiv = formatArxivDate(new Date(fromDate), false);
	const toArxiv = formatArxivDate(new Date(toDate), true);
	const url = new URL(ARXIV_CONFIG.baseUrl);
	url.searchParams.set('search_query', `all:"${keyword}" AND submittedDate:[${fromArxiv} TO ${toArxiv}]`);
	url.searchParams.set('start', '0');
	url.searchParams.set('max_results', '1');

	const xml = await fetchArxivXmlWithThrottle(url.toString());
	const match = String(xml || '').match(/<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i);
	return parseIntegerCount(match ? match[1] : 0);
}

async function fetchKciTrendCount(keyword, fromDate, toDate) {
	const serviceKey = KCI_CONFIG.defaultServiceKey;
	if (!serviceKey) {
		return 0;
	}

	const fromYear = Number(String(fromDate || '').slice(0, 4));
	const toYear = Number(String(toDate || '').slice(0, 4));
	const requestUrl = buildKciDatasetUrl({
		topic: keyword,
		paperType: '',
		field: 'all',
		perPage: 1,
		serviceKey,
		serviceKeyMode: 'auto',
		fromYear,
		toYear
	});

	const json = await fetchJsonWithRetries(requestUrl, {
		headers: { Accept: 'application/json' },
		errorContext: 'KCI trend'
	});

	return parseIntegerCount(
		json?.totalCount
		|| json?.matchCount
		|| json?.currentCount
		|| (Array.isArray(json?.data) ? json.data.length : 0)
		|| extractKciRecords(json).length
	);
}

async function fetchNanetTrendCount(keyword, fromDate, toDate) {
	const apiKey = NANET_CONFIG.apiKey;
	if (!apiKey) {
		return 0;
	}

	// Prefer LOSI trend API first because public NANET search endpoints
	// frequently return 404 depending on environment/key scope.
	try {
		const trend = await getNanetArticleTrend({ searchTerm: keyword });
		const rows = Array.isArray(trend?.data) ? trend.data : [];
		if (rows.length) {
			const fromYear = Number(String(fromDate || '').slice(0, 4));
			const toYear = Number(String(toDate || '').slice(0, 4));
			const total = rows
				.filter((item) => {
					const y = Number(item?.year || 0);
					if (!Number.isFinite(y) || y <= 0) return false;
					if (Number.isFinite(fromYear) && y < fromYear) return false;
					if (Number.isFinite(toYear) && y > toYear) return false;
					return true;
				})
				.reduce((sum, item) => sum + (Number(item?.count) || 0), 0);
			console.log(`[NANET trend] LOSI fallback 사용: keyword="${keyword}" total=${total}`);
			return parseIntegerCount(total);
		}
	} catch (losiError) {
		console.error(`[NANET trend] LOSI fallback 실패: name=${losiError?.name} message=${losiError?.message}`);
	}

	const candidates = buildNanetRequestCandidates({
		topic: keyword,
		pageSize: 1,
		apiKey,
		startDate: String(fromDate || '').replace(/-/g, ''),
		endDate: String(toDate || '').replace(/-/g, '')
	});

	let lastError = null;
	for (let i = 0; i < candidates.length; i += 1) {
		const candidate = candidates[i];
		try {
			const json = await fetchJsonWithRetries(candidate.url, {
				headers: { Accept: 'application/json' },
				errorContext: `NANET trend ${candidate.label}`
			});
			const total = extractNanetTotalCount(json, extractNanetDocuments(json).length);
			if (total > 0 || i === candidates.length - 1) {
				return parseIntegerCount(total);
			}
		} catch (error) {
			lastError = error;
			console.error(`[NANET trend] candidate 실패: ${candidate.label} name=${error?.name} message=${error?.message}`);
		}
	}

	if (lastError) {
		console.error(`[NANET trend] 모든 후보 실패: name=${lastError?.name} message=${lastError?.message}`);
	}
	return 0;
}

function normalizeTrendKeywordConfig(input) {
	if (typeof input === 'string') {
		return {
			topic: input,
			globalQuery: input,
			domesticQuery: input
		};
	}

	const topic = String(input?.topic || input?.globalQuery || input?.domesticQuery || '').trim();
	const globalQuery = String(input?.globalQuery || topic).trim();
	const domesticQuery = String(input?.domesticQuery || topic).trim();

	return {
		topic,
		globalQuery: globalQuery || topic,
		domesticQuery: domesticQuery || topic
	};
}

async function fetchTrendCountsForWindow(keywordConfig, fromDate, toDate) {
	const config = normalizeTrendKeywordConfig(keywordConfig);
	const globalKeyword = config.globalQuery;
	const domesticKeyword = config.domesticQuery;

	const settled = await Promise.allSettled([
		fetchCrossrefTrendCount(globalKeyword, fromDate, toDate),
		fetchArxivTrendCount(globalKeyword, fromDate, toDate),
		fetchKciTrendCount(domesticKeyword, fromDate, toDate),
		fetchNanetTrendCount(domesticKeyword, fromDate, toDate)
	]);

	const names = ['crossref', 'arxiv', 'kci', 'nanet'];
	const bySource = {};
	const errors = {};
	let successSourceCount = 0;

	settled.forEach((result, idx) => {
		const source = names[idx];
		if (result.status === 'fulfilled') {
			successSourceCount += 1;
			bySource[source] = parseIntegerCount(result.value);
			return;
		}
		bySource[source] = 0;
		errors[source] = String(result.reason?.message || result.reason || 'unknown error');
	});

	const total = Object.values(bySource).reduce((sum, value) => sum + parseIntegerCount(value), 0);
	return { total, bySource, errors, successSourceCount };
}

async function fetchCountsForTrendKeyword(keywordConfig, ranges) {
	const config = normalizeTrendKeywordConfig(keywordConfig);
	const recent = await fetchTrendCountsForWindow(config, ranges.recentStartYmd, ranges.recentEndYmd);
	const previous = await fetchTrendCountsForWindow(config, ranges.prevStartYmd, ranges.prevEndYmd);
	const growthRate = computeGrowthRate(recent.total, previous.total);

	return {
		topic: config.topic,
		recent_count: recent.total,
		previous_count: previous.total,
		growth_rate: growthRate,
		sources: {
			recent: recent.bySource,
			previous: previous.bySource
		},
		source_status: {
			recent_success: recent.successSourceCount,
			previous_success: previous.successSourceCount,
			required_success: TREND_MIN_SOURCE_SUCCESS
		},
		errors: {
			recent: recent.errors,
			previous: previous.errors
		},
		is_trending_candidate: recent.total >= TREND_MIN_RECENT_COUNT
			&& growthRate >= TREND_MIN_GROWTH_RATE
			&& recent.successSourceCount >= TREND_MIN_SOURCE_SUCCESS
	};
}

async function getTrendingTopics(options) {
	const topN = clampNumber(options?.topN, 4, 1, 8);
	const forceRefresh = Boolean(options?.forceRefresh);
	const now = Date.now();
	if (!forceRefresh && trendingTopicsCache.expiresAt > now && Array.isArray(trendingTopicsCache.data) && trendingTopicsCache.data.length) {
		return {
			data: trendingTopicsCache.data.slice(0, topN),
			meta: {
				updatedAt: trendingTopicsCache.updatedAt,
				dateRange: trendingTopicsCache.meta.dateRange || null,
				criteria: trendingTopicsCache.meta.criteria || null,
				sampleSize: trendingTopicsCache.meta.sampleSize || 0
			}
		};
	}

	const ranges = getTrendDateRanges();
	const settled = await Promise.allSettled(
		TREND_KEYWORDS.map((keywordConfig) => fetchCountsForTrendKeyword(keywordConfig, ranges))
	);

	const fulfilled = settled
		.filter((result) => result.status === 'fulfilled')
		.map((result) => result.value)
		.filter((item) => Number(item.recent_count || 0) > 0)
		.filter((item) => Number(item.source_status?.recent_success || 0) >= TREND_MIN_SOURCE_SUCCESS);

	const normalizeTrendKey = (item) => String(item.topic || '').trim().toLowerCase();
	const seenTopics = new Set();
	const pushUnique = (list) => {
		const results = [];
		for (const item of list) {
			const key = normalizeTrendKey(item);
			if (!key || seenTopics.has(key)) {
				continue;
			}
			seenTopics.add(key);
			results.push(item);
			if (results.length >= topN) {
				break;
			}
		}
		return results;
	};

	const hot = fulfilled
		.filter((item) => Number(item.growth_rate || 0) >= TREND_MIN_GROWTH_RATE)
		.sort((a, b) => (Number(b.growth_rate || 0) - Number(a.growth_rate || 0)) || (Number(b.recent_count || 0) - Number(a.recent_count || 0)));
	const steady = fulfilled
		.filter((item) => Number(item.growth_rate || 0) >= 0 && Number(item.growth_rate || 0) < TREND_MIN_GROWTH_RATE)
		.sort((a, b) => (Number(b.recent_count || 0) - Number(a.recent_count || 0)) || (Number(b.growth_rate || 0) - Number(a.growth_rate || 0)));
	const popular = fulfilled
		.sort((a, b) => (Number(b.recent_count || 0) - Number(a.recent_count || 0)) || (Number(b.growth_rate || 0) - Number(a.growth_rate || 0)));

	let data = pushUnique(hot);
	if (data.length < topN) {
		data = [...data, ...pushUnique(steady)];
	}
	if (data.length < topN) {
		data = [...data, ...pushUnique(popular)];
	}

	// 4칸 보장: 최종적으로 부족하면 필터를 완화해 TREND_KEYWORDS 전체에서 채움
	if (data.length < topN) {
		for (const item of settled
			.filter((result) => result.status === 'fulfilled')
			.map((result) => result.value)
			.sort((a, b) => (Number(b.recent_count || 0) - Number(a.recent_count || 0)) || (Number(b.growth_rate || 0) - Number(a.growth_rate || 0)))) {
			if (data.length >= topN) break;
			const key = normalizeTrendKey(item);
			if (key && !data.some((entry) => normalizeTrendKey(entry) === key)) {
				data.push(item);
			}
		}
	}
	data = data.slice(0, topN);
	trendingTopicsCache = {
		expiresAt: now + TREND_CACHE_TTL_MS,
		updatedAt: now,
		data,
		meta: {
			dateRange: {
				recentStart: ranges.recentStartYmd,
				recentEnd: ranges.recentEndYmd,
				previousStart: ranges.prevStartYmd,
				previousEnd: ranges.prevEndYmd
			},
			criteria: {
				minRecentCount: TREND_MIN_RECENT_COUNT,
				minGrowthRate: TREND_MIN_GROWTH_RATE,
				minSourceSuccess: TREND_MIN_SOURCE_SUCCESS,
				sort: 'growth_then_volume',
				excludeNegativeGrowth: true,
				excludeZeroRecentCount: true,
				strictTrendingOnly: true
			},
			sampleSize: fulfilled.length
		}
	};

	return {
		data,
		meta: {
			updatedAt: now,
			dateRange: trendingTopicsCache.meta.dateRange,
			criteria: trendingTopicsCache.meta.criteria,
			sampleSize: trendingTopicsCache.meta.sampleSize
		}
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
	console.log(`[KCI] serviceKey 존재 여부: ${!!serviceKey} (길이: ${String(serviceKey || '').length})`);
	if (!serviceKey) {
		console.error('[KCI] serviceKey 없음 — KCI_API_KEY 환경변수를 확인하세요');
		return { data: [], meta: { skipped: true, reason: 'No KCI service key' } };
	}

	const normalizedTopic = normalizeKoreanQueryForDomesticSearch(topic);
	const queryVariants = buildKoreanDomesticQueryVariants(normalizedTopic);
	const perType = Math.max(10, Math.ceil(pageSize / Math.max(1, paperTypes.length)));
	const requests = [];

	for (const paperType of paperTypes) {
		for (const query of queryVariants) {
			requests.push({ paperType, query, useTypeFilter: true });
		}
		// 타입 필터가 너무 좁아 결과가 사라지는 경우를 대비한 백업 쿼리
		requests.push({ paperType, query: queryVariants[0] || topic, useTypeFilter: false });
	}

	const responses = await Promise.all(requests.map(async ({ paperType, query, useTypeFilter }) => {
		const effectiveType = useTypeFilter ? paperType : '';
		const upstreamUrl = buildKciDatasetUrl({
			topic: query,
			paperType: effectiveType,
			field,
			perPage: perType,
			serviceKey,
			serviceKeyMode
		});
		console.log(`[KCI] 요청 시작: type=${effectiveType || '없음'} query="${query}" url=${redactSensitiveUrl(upstreamUrl)}`);
		try {
			const json = await fetchJsonWithRetries(upstreamUrl, {
				headers: { Accept: 'application/json' },
				errorContext: `KCI ${paperType}`
			});
			const rawItems = extractKciRecords(json);
			const totalCount = Number(json?.totalCount || json?.matchCount || json?.currentCount || 0);
			const items = rawItems.map(normalizeKciRecord).filter(Boolean);
			if (rawItems.length && !items.length) {
				const first = rawItems[0] || {};
				console.log(`[KCI] 정규화 누락 감지: type=${effectiveType || '없음'} query="${query}" raw=${rawItems.length} normalized=0 keys=${Object.keys(first).slice(0, 20).join(',')}`);
			}
			if (!rawItems.length && totalCount > 0) {
				console.log(`[KCI] API 카운트 불일치: type=${effectiveType || '없음'} query="${query}" totalCount=${totalCount} raw=0`);
			}
			console.log(`[KCI] 응답 성공: type=${effectiveType || '없음'} query="${query}" 결과=${items.length}건`);
			return { paperType, query, useTypeFilter, url: upstreamUrl, items };
		} catch (err) {
			console.error(`[KCI] 에러: type=${effectiveType || '없음'} query="${query}" name=${err.name} message=${err.message}`);
			return { paperType, query, useTypeFilter, url: upstreamUrl, items: [] };
		}
	}));

	let merged = dedupeNormalizedRecords(responses.flatMap((entry) => entry.items)).slice(0, pageSize);

	if (!merged.length) {
		const fallbackFields = ['제목', '논문명', '주제어', '키워드'];
		const fallbackQueries = dedupeStringArray([normalizedTopic, ...queryVariants.slice(0, 3)]).slice(0, 4);
		const fallbackRequests = [];
		for (const queryField of fallbackFields) {
			for (const query of fallbackQueries) {
				fallbackRequests.push({ queryField, query });
			}
		}

		const fallbackResponses = await Promise.all(fallbackRequests.map(async ({ queryField, query }) => {
			try {
				const upstreamUrl = buildKciDatasetUrl({
					topic: query,
					paperType: '',
					field,
					perPage: Math.max(20, perType),
					serviceKey,
					serviceKeyMode,
					queryField
				});
				console.log(`[KCI] fallback 요청: field=${queryField} query="${query}" url=${redactSensitiveUrl(upstreamUrl)}`);
				const json = await fetchJsonWithRetries(upstreamUrl, {
					headers: { Accept: 'application/json' },
					errorContext: `KCI fallback ${queryField}`
				});
				const rawItems = extractKciRecords(json);
				const totalCount = Number(json?.totalCount || json?.matchCount || json?.currentCount || 0);
				const items = rawItems.map(normalizeKciRecord).filter(Boolean);
				if (rawItems.length && !items.length) {
					const first = rawItems[0] || {};
					console.log(`[KCI] fallback 정규화 누락: field=${queryField} query="${query}" raw=${rawItems.length} normalized=0 keys=${Object.keys(first).slice(0, 20).join(',')}`);
				}
				if (!rawItems.length && totalCount > 0) {
					console.log(`[KCI] fallback API 카운트 불일치: field=${queryField} query="${query}" totalCount=${totalCount} raw=0`);
				}
				console.log(`[KCI] fallback 응답: field=${queryField} query="${query}" 결과=${items.length}건`);
				return items;
			} catch (error) {
				console.error(`[KCI] fallback 실패: field=${queryField} query="${query}" name=${error?.name} message=${error?.message}`);
				return [];
			}
		}));

		merged = dedupeNormalizedRecords(fallbackResponses.flat()).slice(0, pageSize);
	}

	return {
		data: merged,
		meta: {
			totalFetched: merged.length,
			queryVariants,
			normalizedTopic,
			upstreamUrls: responses.map((entry) => redactSensitiveUrl(entry.url))
		}
	};
}

async function searchCrossrefPapers(options) {
	const { translatedTopic, fromYear, untilYear, pageSize, globalTypes = ['journal'], strictRelevance = true } = options;
	if (!globalTypes.length) {
		return { data: [], nextCursor: '', meta: { skipped: true, reason: 'No global type selected' } };
	}
	const queryTokens = tokenizeEnglish(translatedTopic);
	const perPage = Math.min(50, Math.max(20, Math.ceil(pageSize / 4)));
	const maxPages = Math.min(10, Math.max(2, Math.ceil(pageSize / perPage)));
	const typeFilter = buildCrossrefTypeFilter(globalTypes);
	if (!typeFilter) {
		return { data: [], nextCursor: '', meta: { skipped: true, reason: 'No Crossref-compatible type selected' } };
	}
	let cursor = '*';
	let records = [];
	let page = 0;
	const urls = [];

	while (records.length < pageSize && cursor && page < maxPages) {
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
				.filter((record) => (strictRelevance ? isRelevantCrossrefRecord(record, queryTokens) : true))
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
	const { translatedTopic, fromYear, untilYear, globalTypes, pageSize, apiKey, mailto, strictRelevance = true } = options;

	const queryTokens = tokenizeEnglish(translatedTopic);
	const perPage = Math.min(OPENALEX_CONFIG.perPageCap, Math.max(25, Math.min(pageSize, 100)));
	const maxPages = Math.min(6, Math.max(1, Math.ceil(pageSize / perPage)));
	const urls = [];
	let records = [];

	for (let page = 1; page <= maxPages && records.length < pageSize; page += 1) {
		const requestUrl = buildOpenAlexUrl({
			translatedTopic,
			fromYear,
			untilYear,
			globalTypes,
			perPage,
			apiKey,
			mailto,
			page
		});
		urls.push(requestUrl);

		const json = await fetchJsonWithRetries(requestUrl, {
			headers: {
				Accept: 'application/json',
				'User-Agent': `global-paper-analyzer/1.0 (mailto:${mailto || CROSSREF_MAILTO})`
			},
			errorContext: 'OpenAlex'
		});

		const items = Array.isArray(json?.results) ? json.results : [];
		records = records.concat(
			items
				.map(normalizeOpenAlexRecord)
				.filter(Boolean)
				.filter((record) => (strictRelevance ? isRelevantCrossrefRecord(record, queryTokens) : true))
		);

		if (!items.length || items.length < perPage) {
			break;
		}
	}

	records = dedupeNormalizedRecords(records).slice(0, pageSize);

	return {
		data: records,
		meta: {
			totalFetched: records.length,
			requestUrls: urls
		}
	};
}

async function searchSemanticScholarPapers(options) {
	const { topic, pageSize, fromYear, untilYear } = options;
	const perPage = Math.min(100, Math.max(10, pageSize));
	const fields = 'title,abstract,year,authors,citationCount,externalIds,publicationTypes,journal,openAccessPdf';
	const queries = dedupeStringArray([topic, normalizeKoreanQueryForDomesticSearch(topic)]).filter(Boolean).slice(0, 3);
	const collected = [];

	for (const q of queries) {
		try {
			const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${perPage}&fields=${encodeURIComponent(fields)}`;
			console.log(`[SemanticScholar] 요청: query="${q}"`);
			const json = await fetchJsonWithRetries(url, {
				headers: { Accept: 'application/json', 'User-Agent': 'global-paper-analyzer/1.0' },
				errorContext: 'SemanticScholar'
			});
			const items = Array.isArray(json?.data) ? json.data : [];
			console.log(`[SemanticScholar] 응답: query="${q}" 결과=${items.length}건`);
			for (const item of items) {
				if (!item.title) continue;
				const year = Number(item.year) || 0;
				if (year && fromYear && year < fromYear) continue;
				if (year && untilYear && year > untilYear) continue;
				const authors = Array.isArray(item.authors)
					? item.authors.map((a) => a.name || '').filter(Boolean).join(', ')
					: '저자 미상';
				const doi = item.externalIds?.DOI ? normalizeDoi(String(item.externalIds.DOI)) : '';
				const journal = item.journal?.name || 'SemanticScholar';
				const pdfUrl = item.openAccessPdf?.url || '';
				const isKorean = /[\uAC00-\uD7AF]/.test(item.title) || /[\uAC00-\uD7AF]/.test(item.abstract || '');
				collected.push({
					title: String(item.title).trim(),
					abstract: stripHtml(String(item.abstract || '').trim()),
					keywords: [],
					year: year || null,
					author: authors || '저자 미상',
					type: isKorean ? '국내 논문' : 'International Article',
					field: '미상',
					journal: String(journal).trim(),
					citationCount: Number(item.citationCount) || 0,
					doi,
					url: pdfUrl || (doi ? `https://doi.org/${doi}` : ''),
					source: isKorean ? 'SemanticScholar-KO' : 'SemanticScholar',
					language: isKorean ? 'ko' : 'en'
				});
			}
		} catch (err) {
			console.error(`[SemanticScholar] 에러: query="${q}" ${err.message}`);
		}
	}

	const deduped = dedupeNormalizedRecords(collected).slice(0, pageSize);
	console.log(`[SemanticScholar] 최종: ${deduped.length}건 (Korean=${deduped.filter((p) => p.language === 'ko').length}건)`);
	return { data: deduped, meta: { totalFetched: deduped.length } };
}

async function searchOpenAlexKoreanPapers(options) {
	const { topic, fromYear, untilYear, pageSize, apiKey, mailto } = options;
	const translatedTopic = normalizeKoreanQueryForDomesticSearch(topic);
	const perPage = Math.min(OPENALEX_CONFIG.perPageCap, Math.max(20, pageSize));
	const params = new URLSearchParams({
		search: translatedTopic,
		filter: `publication_year:${fromYear}-${untilYear},language:ko`,
		select: OPENALEX_CONFIG.select,
		per_page: String(perPage),
		page: '1'
	});
	if (mailto || apiKey) params.set('mailto', mailto || apiKey);

	const url = `${OPENALEX_CONFIG.baseUrl}?${params.toString()}`;
	console.log(`[OpenAlexKO] 요청: query="${translatedTopic}" filter=language:ko`);
	try {
		const json = await fetchJsonWithRetries(url, {
			headers: { Accept: 'application/json', 'User-Agent': `global-paper-analyzer/1.0 (mailto:${mailto || CROSSREF_MAILTO})` },
			errorContext: 'OpenAlexKO'
		});
		const items = Array.isArray(json?.results) ? json.results : [];
		console.log(`[OpenAlexKO] 응답: ${items.length}건`);
		const records = items.map(normalizeOpenAlexRecord).filter(Boolean).map((r) => ({
			...r,
			source: 'OpenAlex-KO',
			language: 'ko',
			type: '국내 논문'
		}));
		const deduped = dedupeNormalizedRecords(records).slice(0, pageSize);
		console.log(`[OpenAlexKO] 최종: ${deduped.length}건`);
		return { data: deduped, meta: { totalFetched: deduped.length } };
	} catch (err) {
		console.error(`[OpenAlexKO] 에러: ${err.message}`);
		return { data: [], meta: { error: err.message } };
	}
}

async function searchNanetPapers(options) {
	const { topic, apiKey, pageSize, fromYear, untilYear } = options;

	if (!apiKey) {
		return { data: [], meta: { skipped: true, reason: 'No NANET API key' } };
	}

	const candidates = buildNanetRequestCandidates({ topic, pageSize, apiKey });
	let lastError = null;
	let bestEmptyMeta = null;

	for (const candidate of candidates) {
		try {
			console.log(`[NANET] 요청 시작: query="${topic}" candidate=${candidate.label} url=${redactSensitiveUrl(candidate.url)}`);
			const response = await fetchJsonWithRetries(candidate.url, {
				headers: { Accept: 'application/json' },
				errorContext: `NANET ${candidate.label}`
			});

			const docs = extractNanetDocuments(response);
			const records = docs
				.map((doc) => normalizeNanetRecord(doc, fromYear, untilYear))
				.filter(Boolean);
			const totalCount = extractNanetTotalCount(response, records.length);
			console.log(`[NANET] 응답 성공: candidate=${candidate.label} 결과=${records.length}건 (totalCount=${totalCount})`);

			if (records.length > 0 || totalCount > 0) {
				return {
					data: records,
					meta: {
						totalFetched: records.length,
						requestUrl: candidate.url,
						totalCount,
						candidate: candidate.label
					}
				};
			}

			if (!bestEmptyMeta) {
				bestEmptyMeta = {
					totalFetched: 0,
					requestUrl: candidate.url,
					totalCount,
					candidate: candidate.label
				};
			}
		} catch (error) {
			lastError = error;
			console.error(`[NANET] candidate 실패: ${candidate.label} name=${error?.name} message=${error?.message}`);
		}
	}

	if (bestEmptyMeta) {
		// LOSI fallback: when public search endpoints are unavailable, try
		// a best-effort article search endpoint from the same NANET detail API.
		try {
			const losiFallback = await searchNanetPapersViaLosi({
				topic,
				pageSize,
				fromYear,
				untilYear
			});
			if (losiFallback.data.length) {
				return losiFallback;
			}
		} catch (losiError) {
			console.error(`[NANET] LOSI fallback 실패: name=${losiError?.name} message=${losiError?.message}`);
		}

		return { data: [], meta: bestEmptyMeta };
	}

	console.error(`[NANET] 에러: name=${lastError && lastError.name} message=${lastError && lastError.message}`);
	return {
		data: [],
		meta: {
			skipped: true,
			reason: lastError && lastError.message ? lastError.message : 'NANET API request failed'
		}
	};
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
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000); // 5초 timeout으로 단축
		const json = await fetch(translationUrl.toString(), {
			headers: { Accept: 'application/json' },
			signal: controller.signal
		}).then(r => r.json()).finally(() => clearTimeout(timeoutId));
		
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

const KO_TO_EN_TERMS = {
	'자기효능감': 'self-efficacy self-confidence psychological empowerment',
	'자기효능': 'self-efficacy',
	'생성형 ai': 'generative ai',
	'생성형ai': 'generative ai',
	'프로그래머': 'programmer software developer',
	'개발자': 'developer software engineer',
	'예술가': 'artist creator creative professional',
	'창작자': 'artist creator creative professional',
	'디자이너': 'designer creative professional',
	'활용': 'utilization use impact',
	'영향': 'impact effect influence',
	'교사': 'teacher',
	'학생': 'student',
	'학습': 'learning'
};

function koreanTermExpansion(text) {
	const input = String(text || '').trim();
	if (!input) {
		return '';
	}

	const appendedTerms = [];
	for (const [ko, en] of Object.entries(KO_TO_EN_TERMS)) {
		if (input.toLowerCase().includes(ko.toLowerCase())) {
			appendedTerms.push(en);
		}
	}

	if (!appendedTerms.length) {
		return input;
	}

	return `${input} ${dedupeStringArray(appendedTerms).join(' ')}`.trim();
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
		// LLM 요청 시 5초 timeout으로 단축 (재시도 없음)
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000);
		
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${LLM_EXPANSION_CONFIG.apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload),
			signal: controller.signal
		});
		clearTimeout(timeoutId);

		if (!response.ok) {
			return null;
		}

		const json = await response.json();
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

	const expandedOriginal = koreanTermExpansion(original);
	const englishTerms = dedupeStringArray([
		...expandKoreanAcademicTerms(expandedOriginal),
		...koreanTermExpansion(original).split(/\s+/).filter((token) => /[a-z]/i.test(token))
	]);
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

	if (/자기효능감/.test(original) || /self-efficacy/i.test(translated)) {
		candidate.push([
			'self-efficacy',
			'academic self-efficacy',
			'programmer self-efficacy',
			'student self-efficacy',
			'artist self-efficacy',
			'creative self-efficacy',
			'developer self-efficacy'
		].join(' '));
	}

	if (!candidate.length) {
		return original;
	}

	const mergedTokens = dedupeStringArray(candidate.join(' ').split(/\s+/)).slice(0, 24);
	return mergedTokens.join(' ');
}

async function buildQueryPack(topic) {
	const primaryQueryKo = String(topic || '').trim();
	
	// 병렬로 전부 실행하되, timeout으로 빠르게 실패하게 함
	const [translatedTopic, coreKeywordsKo] = await Promise.all([
		translateTopicToEnglish(primaryQueryKo),
		Promise.resolve(extractCoreKeywords(primaryQueryKo))
	]);
	
	const baseEnglishQuery = buildGlobalQueryText(primaryQueryKo, translatedTopic);
	const expansionTargets = coreKeywordsKo.slice(0, 4);
	
	// 병렬 확장 - 실패 안전
	const keywordExpansions = await Promise.allSettled(
		expansionTargets.map((keyword) => 
			Promise.race([
				resolveAcademicKeywordExpansion(keyword),
				new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
			])
		)
	).then(results => 
		results.map(r => r.status === 'fulfilled' ? r.value : {
			keyword: '',
			source: 'fallback',
			synonyms: [],
			entities: [],
			fallbackTranslation: ''
		})
	);
	
	// General self-efficacy queries should not be biased toward programmer/developer papers.
	// Only add person-specific hints when the query explicitly mentions those roles.
	const isAgentSpecific = /프로그래머|개발자|programmer|developer|artist|creator|designer/i.test(primaryQueryKo);
	const selfEfficacyHints = /자기효능감|self-efficacy/i.test(primaryQueryKo)
		? [
			'self-efficacy',
			'academic self-efficacy',
			...(isAgentSpecific ? ['developer confidence', 'programmer'] : ['student self-efficacy', 'learner self-efficacy'])
		]
		: [];

	const coreKeywordsEn = dedupeStringArray(keywordExpansions.flatMap((item) => [
		...(item.synonyms || []).slice(0, 1),
		...(item.entities || []).slice(0, 1),
		item.fallbackTranslation || ''
	]).concat(selfEfficacyHints));

	const primaryQueryEn = dedupeStringArray([
		...tokenizeEnglish(baseEnglishQuery),
		...coreKeywordsEn.flatMap((item) => String(item).split(/\s+/))
	]).slice(0, 24).join(' ') || baseEnglishQuery || primaryQueryKo;

	// 확장 쿼리 생성을 단순화
	const expandedQueries = [];
	for (const expansion of keywordExpansions.slice(0, 2)) {
		for (const alternative of (expansion.entities || []).slice(0, 2)) {
			expandedQueries.push(dedupeStringArray([...tokenizeEnglish(primaryQueryEn), ...alternative.split(/\s+/)]).slice(0, 24).join(' '));
		}
	}

	return {
		primaryQueryKo,
		primaryQueryEn,
		translatedTopic,
		globalQueryTopic: primaryQueryEn,
		expandedQueries: dedupeStringArray(expandedQueries.filter(Boolean)).filter((query) => query && query !== primaryQueryEn).slice(0, 3),
		coreKeywordsKo: coreKeywordsKo.slice(0, 4),
		coreKeywordsEn: dedupeStringArray(coreKeywordsEn),
		keywordExpansionSources: keywordExpansions.map((item) => ({
			keyword: item.keyword || '',
			source: item.source || 'fallback',
			synonymCount: (item.synonyms || []).length,
			entityCount: (item.entities || []).length
		}))
	};
}

function extractCoreKeywords(topic) {
	const text = String(topic || '').trim();
	const priorityTerms = ['자기효능감', '프로그래머', '개발자', '소프트웨어', '생성형', '인공지능', 'ai'];
	const prioritized = priorityTerms.filter((term) => text.toLowerCase().includes(term.toLowerCase()));
	const matchedDictionaryTerms = [
		...Object.keys(CONCEPT_SYNONYM_MAP).filter((keyword) => text.includes(keyword)),
		...Object.keys(ENTITY_SUBSTITUTION_MAP).filter((keyword) => text.includes(keyword))
	];

	const tokenCandidates = text
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 2);

	return dedupeStringArray([...prioritized, ...matchedDictionaryTerms, ...tokenCandidates]).slice(0, 10);
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
		// 개발자/프로그래머 도메인
		[/프로그래머/g, 'programmer coder software developer'],
		[/개발자(?!도구|환경|경험)/g, 'developer software engineer programmer'],
		[/소프트웨어 개발|sw 개발|앱 개발/g, 'software development programming'],
		[/소프트웨어 공학|sw 공학|sw 엔지니어링/g, 'software engineering'],
		[/코딩|코드 생성|프로그래밍/g, 'coding programming code generation'],
		// 심리/자기효능감 도메인
		[/자기효능감/g, 'self-efficacy confidence psychological belief'],
		[/효능감(?!자기)/g, 'efficacy confidence self-efficacy'],
		[/직무 만족|업무 만족/g, 'job satisfaction work satisfaction'],
		[/생산성|업무 효율|직무 성과/g, 'productivity performance work efficiency'],
		// 기존 항목
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

// 쿼리에서 도메인 필수 키워드 범주를 감지하고 반환합니다.
// 번역된 쿼리에 특정 도메인 키워드(개발자/프로그래머, 자기효능감 등)가 포함된 경우
// 논문 필터링에 사용할 범주별 필수 키워드 목록을 반환합니다.
function buildDomainMustKeywords(queryPack) {
	const queryText = [
		queryPack.translatedTopic || '',
		queryPack.primaryQueryEn || ''
	].join(' ').toLowerCase();

	const DOMAIN_CATEGORY_MAP = {
		agent: {
			detect: ['programmer', 'developer', 'software engineer', 'coder', 'artist', 'creator', 'designer'],
			must: ['programmer', 'developer', 'software engineer', 'coder', 'artist', 'creator', 'designer', 'software development', 'engineering']
		},
		psychology: {
			detect: ['self-efficacy', 'self efficacy', 'efficacy', 'confidence', 'psychological'],
			// Use only compound/specific terms to avoid false positives:
			// - standalone 'efficacy' matches medical papers (drug/vaccine efficacy)
			// - standalone 'confidence' matches ML papers (confidence intervals/scores)
			must: ['self-efficacy', 'self efficacy', 'psychological', '자기효능감']
		}
	};

	const mustKeywordsByCategory = {};
	for (const [category, { detect, must }] of Object.entries(DOMAIN_CATEGORY_MAP)) {
		if (detect.some((kw) => queryText.includes(kw.toLowerCase()))) {
			mustKeywordsByCategory[category] = must;
		}
	}
	return mustKeywordsByCategory;
}

// 수집된 논문 목록을 도메인 필수 키워드 기준으로 필터링합니다.
// 감지된 각 도메인 범주에 대해 논문 제목/초록에 해당 키워드가 하나 이상 포함되어야 합니다.
function filterByDomainRelevance(papers, mustKeywordsByCategory) {
	const categories = Object.keys(mustKeywordsByCategory);
	if (!categories.length) return papers;

	const scored = papers
		.map((paper) => {
			const text = [
				paper.title || '',
				paper.abstract || '',
				...(Array.isArray(paper.keywords) ? paper.keywords : [])
			].join(' ').toLowerCase();

			const categoryPass = categories.every((category) =>
				mustKeywordsByCategory[category].some((kw) => text.includes(kw.toLowerCase()))
			);
			const boost = computePaperDomainBoostScore(paper, mustKeywordsByCategory);
			return { paper, categoryPass, boost };
		})
		.filter((item) => item.categoryPass && item.boost >= 0.2)
		.sort((a, b) => b.boost - a.boost)
		.map((item) => item.paper);

	if (scored.length >= 4) {
		console.log(`[domain-filter] ${scored.length}/${papers.length}개 논문이 도메인 필터 통과`);
		return scored;
	}

	// strict 필터 결과가 너무 적으면, 일치도가 높은 순으로 보강
	const relaxed = papers
		.map((paper) => ({ paper, boost: computePaperDomainBoostScore(paper, mustKeywordsByCategory) }))
		.sort((a, b) => b.boost - a.boost)
			.filter((item) => item.boost >= 0.15)
			.slice(0, Math.min(20, papers.length))
			.map((item) => item.paper);
	if (relaxed.length) {
		console.log(`[domain-filter] strict 결과 부족 (${scored.length}/${papers.length}), relaxed ${relaxed.length}건 반환`);
		return relaxed;
	}

	if (!scored.length && papers.length) {
		// 엄격 필터로 0건이 되면 도메인 부스트 상위 논문을 최소한으로 반환
		const fallback = papers
			.map((paper) => ({ paper, boost: computePaperDomainBoostScore(paper, mustKeywordsByCategory) }))
			.filter((item) => item.boost >= 0.08)
			.sort((a, b) => b.boost - a.boost)
			.slice(0, Math.min(12, papers.length))
			.map((item) => item.paper);
		console.log(`[domain-filter] strict 결과 0건, fallback ${fallback.length}건 반환`);
		return fallback;
	}

	console.log(`[domain-filter] ${scored.length}/${papers.length}개 논문이 도메인 필터 통과`);
	return scored;
}

function buildKoreanDomesticQueryVariants(topic) {
	const base = String(topic || '').trim();
	if (!base) {
		return [];
	}

	const normalized = normalizeKoreanQueryForDomesticSearch(base)
		.replace(/["'`]/g, ' ')
		.replace(/[()\[\]{}]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	const keywords = extractCoreKeywords(normalized)
		.filter((token) => /[가-힣a-zA-Z]/.test(token))
		.filter((token) => !['영향', '효과', '활용', '활용이', '연구', '분석', '중심', '미치는', '미치', '대한', '자기', '효능감에', '효능감'].includes(token))
		.slice(0, 6);
	const englishBoost = /자기효능감|self-efficacy/i.test(normalized)
		? ['self-efficacy', 'academic self-efficacy', 'developer confidence', 'artist creativity confidence', 'programmer self-efficacy']
		: [];

	const compactConceptQuery = dedupeStringArray([
		/자기효능감|self-efficacy/i.test(normalized) ? '자기효능감' : '',
		/생성형|genai|generative|ai/i.test(normalized) ? '생성형 AI' : '',
		/academic self-efficacy|학습효능감|learner self-efficacy/i.test(normalized) ? 'academic self-efficacy' : ''
	]).join(' ').trim();

	const pairs = [];
	for (let i = 0; i < keywords.length; i += 1) {
		for (let j = i + 1; j < keywords.length; j += 1) {
			pairs.push(`${keywords[i]} ${keywords[j]}`);
		}
	}

	return dedupeStringArray([
		compactConceptQuery,
		normalized,
		...keywords,
		...englishBoost,
		...pairs
	]).slice(0, 8);
}

function normalizeKoreanQueryForDomesticSearch(text) {
	let normalized = String(text || '').trim();
	if (!normalized) return '';

	normalized = normalized
		.replace(/자기\s+효능감/g, '자기효능감')
		.replace(/학습\s+효능감/g, '학습효능감')
		.replace(/생성형\s+ai/gi, '생성형 AI');

	const cleaned = normalized
		.split(/\s+/)
		.map((token) => token.replace(/(은|는|이|가|을|를|에|의|와|과|로|으로|도|만)$/u, ''))
		.filter((token) => token.length >= 2)
		.join(' ')
		.trim();

	return cleaned || normalized;
}

function redactSensitiveUrl(value) {
	try {
		const url = new URL(String(value || ''));
		if (url.searchParams.has('serviceKey')) {
			url.searchParams.set('serviceKey', '***');
		}
		if (url.searchParams.has('key')) {
			url.searchParams.set('key', '***');
		}
		return url.toString();
	} catch (_error) {
		return String(value || '');
	}
}

// BM25-스타일 도메인 키워드 부스트 점수 계산 (0.0 ~ 1.0)
// md 파일의 keyword_boost_score에 해당하는 로직
function computePaperDomainBoostScore(paper, mustKeywordsByCategory) {
	const allMustKeywords = Object.values(mustKeywordsByCategory).flat();
	if (!allMustKeywords.length) return 0;

	const text = [
		paper.title || '',
		paper.abstract || '',
		...(Array.isArray(paper.keywords) ? paper.keywords : [])
	].join(' ').toLowerCase();

	const matches = allMustKeywords.filter((kw) => text.includes(kw.toLowerCase())).length;
	return Math.min(matches / Math.max(allMustKeywords.length, 5), 1.0);
}

function buildKciDatasetUrl(options) {
	const { topic, paperType, field, perPage, serviceKey, serviceKeyMode, fromYear, toYear, queryField = '논문명' } = options;
	// URLSearchParams encodes bracket-style param names (cond[...]) which KCI API may not recognize.
	// Build query string manually so bracket notation stays raw while values are encoded.
	const safeField = String(queryField || '논문명').replace(/[\[\]]/g, '').trim() || '논문명';
	const parts = [
		'returnType=json',
		'page=1',
		`perPage=${Number(perPage) || 10}`,
		`cond[${safeField}::LIKE]=${encodeURIComponent(topic)}`
	];

	const mappedType = PAPER_TYPE_MAP[paperType];
	if (mappedType) {
		parts.push(`cond[학위구분::EQ]=${encodeURIComponent(mappedType)}`);
	}
	if (field && field !== 'all') {
		parts.push(`cond[학문분야::LIKE]=${encodeURIComponent(field)}`);
	}
	if (Number.isFinite(Number(fromYear))) {
		parts.push(`cond[발행연도::GTE]=${Math.floor(Number(fromYear))}`);
	}
	if (Number.isFinite(Number(toYear))) {
		parts.push(`cond[발행연도::LTE]=${Math.floor(Number(toYear))}`);
	}

	return `${KCI_CONFIG.baseUrl}${KCI_CONFIG.datasetPath}?serviceKey=${buildServiceKeyPart(serviceKey, serviceKeyMode)}&${parts.join('&')}`;
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
	const { translatedTopic, fromYear, untilYear, globalTypes, perPage, apiKey, mailto, page = 1 } = options;
	const url = new URL(OPENALEX_CONFIG.baseUrl);
	url.searchParams.set('search', translatedTopic);
	if (apiKey) {
		url.searchParams.set('api_key', apiKey);
	}
	url.searchParams.set('mailto', mailto || CROSSREF_MAILTO);
	url.searchParams.set('per-page', String(perPage));
	url.searchParams.set('page', String(Math.max(1, Number(page) || 1)));
	url.searchParams.set('sort', 'cited_by_count:desc');
	url.searchParams.set('select', OPENALEX_CONFIG.select);
	const typeFilter = buildOpenAlexTypeFilter(globalTypes);
	url.searchParams.set('filter', `type:${typeFilter},from_publication_date:${fromYear}-01-01,to_publication_date:${untilYear}-12-31`);
	return url.toString();
}

function buildNanetUrl(options) {
	const { topic, pageSize, apiKey } = options;
	const url = new URL(NANET_CONFIG.baseUrl);
	url.searchParams.set('apiKey', apiKey);
	url.searchParams.set('searchKey', topic);
	url.searchParams.set('pageSize', String(Math.min(pageSize, NANET_CONFIG.perPageCap)));
	url.searchParams.set('pageNum', '1');
	url.searchParams.set('resultType', 'json');
	return url.toString();
}

function buildNanetRequestCandidates(options) {
	const { topic, pageSize, apiKey, startDate, endDate } = options;
	const bases = dedupeStringArray([
		String(NANET_CONFIG.baseUrl || '').trim(),
		String(NANET_CONFIG.legacyBaseUrl || '').trim()
	]).filter(Boolean);

	try {
		const candidates = buildNanetRequestCandidates({ topic, pageSize, apiKey });
		let lastError = null;
		let bestEmptyMeta = null;
		modernUrl.searchParams.set('apiKey', apiKey);
		for (const candidate of candidates) {
			try {
				console.log(`[NANET] 요청 시작: query="${topic}" candidate=${candidate.label} url=${redactSensitiveUrl(candidate.url)}`);
				const response = await fetchJsonWithRetries(candidate.url, {
					headers: { Accept: 'application/json' },
					errorContext: `NANET ${candidate.label}`
				});

				const docs = extractNanetDocuments(response);
				const records = docs
					.map((doc) => normalizeNanetRecord(doc, fromYear, untilYear))
					.filter(Boolean);
				const totalCount = extractNanetTotalCount(response, records.length);
				console.log(`[NANET] 응답 성공: candidate=${candidate.label} 결과=${records.length}건 (totalCount=${totalCount})`);

				if (records.length > 0 || totalCount > 0) {
					return {
						data: records,
						meta: {
							totalFetched: records.length,
							requestUrl: candidate.url,
							totalCount,
							candidate: candidate.label
						}
					};
				}

				if (!bestEmptyMeta) {
					bestEmptyMeta = {
						totalFetched: 0,
						requestUrl: candidate.url,
						totalCount,
						candidate: candidate.label
					};
				}
			} catch (error) {
				lastError = error;
				console.error(`[NANET] candidate 실패: ${candidate.label} name=${error?.name} message=${error?.message}`);
			}
		}

		if (bestEmptyMeta) {
			try {
				const losiFallback = await searchNanetPapersViaLosi({
					topic,
					pageSize,
					fromYear,
					untilYear
				});
				if (losiFallback.data.length) {
					return losiFallback;
				}
			} catch (losiError) {
				console.error(`[NANET] LOSI fallback 실패: name=${losiError?.name} message=${losiError?.message}`);
			}

			return { data: [], meta: { ...bestEmptyMeta, skipped: false, reason: '' } };
		}

		return {
			data: [],
			meta: {
				totalFetched: 0,
				skipped: false,
				reason: '',
				candidate: 'none'
			}
		};
	} catch (error) {
		console.error(`[NANET] 에러: name=${error?.name} message=${error?.message}`);
		return {
			data: [],
			meta: {
				totalFetched: 0,
				skipped: false,
				reason: '',
				candidate: 'exception'
			}
 		};
	}

}

async function fetchJsonWithRetries(url, options) {
	const { headers = {}, errorContext = 'Request' } = options || {};
	let lastError = null;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(60000) // Render Cold Start 고려: 60초
			});

			if (/kci|nanet/i.test(errorContext)) {
				console.log(`[${errorContext}] HTTP 응답 상태: ${response.status} ${response.statusText}`);
			}

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

			const responseText = await response.text();
			if (responseText.trimStart().startsWith('<')) {
				throw createError(503, `${errorContext} 서버가 HTML 페이지를 반환했습니다 (IP 접근 제한 또는 서버 오류)`);
			}
			try {
				return JSON.parse(responseText);
			} catch (_parseErr) {
				throw createError(502, `${errorContext} 응답을 JSON으로 파싱할 수 없습니다`);
			}
		} catch (error) {
			lastError = error;
			if (/kci|nanet/i.test(errorContext)) {
				console.error(`[${errorContext}] fetch 예외 (attempt ${attempt + 1}): name=${error.name} message=${error.message}`);
			}
			if (!shouldRetry(error) || attempt === 1) {
				throw error;
			}
			await wait(200);
		}
	}

	throw lastError || createError(500, `${errorContext} failed`);
}

async function postJsonWithRetries(url, options) {
	const {
		headers = {},
		body = {},
		errorContext = 'Request',
		timeoutMs = 5000  // 20초 → 5초
	} = options || {};
	let lastError = null;

	for (let attempt = 0; attempt < 2; attempt += 1) {
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
			if (!shouldRetry(error) || attempt === 1) {
				throw error;
			}
			await wait(200);
		}
	}

	throw lastError || createError(500, `${errorContext} failed`);
}

async function postFormWithRetries(url, options) {
	const {
		headers = {},
		form = {},
		errorContext = 'Request',
		timeoutMs = 20000
	} = options || {};
	let lastError = null;

	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const formBody = form instanceof URLSearchParams
				? form.toString()
				: new URLSearchParams(Object.entries(form || {}).filter(([, value]) => value !== undefined && value !== null)).toString();

			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					...headers
				},
				body: formBody,
				signal: AbortSignal.timeout(timeoutMs)
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

			const text = await safeReadText(response);
			if (!text) {
				return {};
			}

			try {
				return JSON.parse(text);
			} catch (_error) {
				throw createError(502, `${errorContext} 응답 파싱 실패`);
			}
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

function dedupeStringArray(values) {
	return Array.from(new Set((values || []).filter(Boolean).map((item) => String(item).trim())));
}

function dedupeByKey(items, keyFn) {
	const seen = new Set();
	const out = [];
	for (const item of (items || [])) {
		const key = String(keyFn ? keyFn(item) : '').trim();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
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

		const responseData = await postFormWithRetries(url, {
			headers: {
				Accept: 'application/json'
			},
			form: body,
			errorContext: 'NANET API',
			timeoutMs: 20000
		});

		const resultCode = String(responseData?.resultCode || responseData?.code || '').trim();
		const resultMsg = String(responseData?.resultMsg || responseData?.message || '').trim();
		if (resultCode && !['0', '00', 'success', 'SUCCESS'].includes(resultCode)) {
			if (/인증|auth|key|unauthorized|forbidden/i.test(resultCode + resultMsg)) {
				throw createError(401, `NANET 인증 오류: ${resultMsg || resultCode}`);
			}
			throw createError(502, `NANET 응답 오류: ${resultMsg || resultCode}`);
		}

		return responseData;
	} catch (error) {
		if (error.statusCode) {
			throw error;
		}
		if (error.name === 'AbortError' || /timeout|timed out/i.test(String(error.message || ''))) {
			throw createError(504, 'NANET API 서버 응답이 없습니다. 잠시 후 다시 시도하세요.');
		}
		if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(String(error.message || ''))) {
			throw createError(504, 'NANET API 서버에 연결할 수 없습니다. 잠시 후 다시 시도하세요.');
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

const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css',
	'.js': 'application/javascript',
	'.json': 'application/json',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.eot': 'application/vnd.ms-fontobject'
};

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
	const requestOrigin = String(req.headers.origin || '').trim();
	const allowOrigin = resolveAllowedOrigin(requestOrigin);
	if (allowOrigin) {
		res.setHeader('Access-Control-Allow-Origin', allowOrigin);
	}
	res.setHeader('Vary', 'Origin');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	res.setHeader('Access-Control-Max-Age', '86400');
}

function resolveAllowedOrigin(requestOrigin) {
	if (CORS_ALLOW_ALL) {
		return '*';
	}
	if (!requestOrigin || requestOrigin === 'null') {
		return '*';
	}
	return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : '';
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
	const haystackTokens = new Set(tokenizeEnglish(`${record.title} ${record.abstract} ${(record.keywords || []).join(' ')}`));
	if (!haystackTokens.size) {
		return false;
	}
	const overlap = queryTokens.filter((token) => haystackTokens.has(token)).length;

	// 도메인 특화 키워드(programmer, self-efficacy 등)가 쿼리에 있으면 더 엄격하게 검사
	const DOMAIN_SPECIFIC_TOKENS = new Set([
		'programmer', 'developer', 'coder',
		'self-efficacy', 'efficacy', 'confidence', 'psychological',
		'software', 'coding', 'programming'
	]);
	const domainTokensInQuery = queryTokens.filter((t) => DOMAIN_SPECIFIC_TOKENS.has(t));
	if (domainTokensInQuery.length >= 2) {
		// 도메인 쿼리: 전체 매칭 20% 이상 AND 도메인 키워드 최소 1개 포함
		// (30% → 20%: 자기효능감 관련 논문은 query token 중 일부만 포함하므로 완화)
		const minOverall = Math.max(2, Math.floor(queryTokens.length * 0.2));
		const hasDomainMatch = domainTokensInQuery.some((t) => haystackTokens.has(t));
		return overlap >= minOverall && hasDomainMatch;
	}

	// 일반 쿼리: 기존 20% 기준 유지
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
	const normalizeText = (value) => decodeXmlEntities(String(value || '').replace(/\s+/g, ' ').trim());
	const toArray = (value) => (Array.isArray(value) ? value : (value ? [value] : []));

	let parsed;
	try {
		parsed = ARXIV_XML_PARSER.parse(String(xml || ''));
	} catch (_error) {
		return [];
	}

	const feed = parsed && parsed.feed && typeof parsed.feed === 'object' ? parsed.feed : {};
	const entryNodes = toArray(feed.entry);

	return entryNodes.map((entryNode) => {
		const title = normalizeText(entryNode && entryNode.title);
		const summary = normalizeText(entryNode && entryNode.summary);
		const published = normalizeText(entryNode && entryNode.published);
		const id = normalizeText(entryNode && entryNode.id);

		const authors = toArray(entryNode && entryNode.author)
			.map((authorNode) => normalizeText(authorNode && authorNode.name ? authorNode.name : authorNode))
			.filter(Boolean);

		const categories = toArray(entryNode && entryNode.category)
			.map((categoryNode) => normalizeText(categoryNode && categoryNode.term ? categoryNode.term : ''))
			.filter(Boolean);

		let htmlLink = '';
		for (const linkNode of toArray(entryNode && entryNode.link)) {
			if (!linkNode || typeof linkNode !== 'object') {
				continue;
			}
			const href = normalizeText(linkNode.href);
			const rel = normalizeText(linkNode.rel);
			const type = normalizeText(linkNode.type);
			if (href && rel === 'alternate' && (!type || type === 'text/html')) {
				htmlLink = href;
				break;
			}
		}

		return {
			title,
			summary,
			published,
			id,
			authors,
			categories,
			htmlLink: htmlLink || id
		};
	}).filter((entry) => entry.title || entry.id);
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

function decodeXmlEntities(value) {
	return String(value || '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

async function searchNanetPapersViaLosi(options) {
	const { topic, pageSize, fromYear, untilYear } = options;
	const endpointCandidates = ['/articleSearch', '/searchArticle', '/articleList'];
	let lastError = null;

	for (const endpoint of endpointCandidates) {
		try {
			const response = await nanetApiRequest(endpoint, {
				searchTerm: topic,
				query: topic,
				pageNum: 1,
				pageSize: Math.min(pageSize, NANET_CONFIG.perPageCap),
				resultType: 'json'
			});
			const docs = pickNanetList(response, [
				'result.articleList',
				'articleList',
				'result.documents',
				'documents',
				'result.items',
				'items',
				'result.list',
				'list'
			]);
			const records = docs
				.map((doc) => normalizeNanetRecord(doc, fromYear, untilYear))
				.filter(Boolean)
				.slice(0, pageSize);

			console.log(`[NANET] LOSI fallback 성공: endpoint=${endpoint} 결과=${records.length}건`);
			return {
				data: records,
				meta: {
					totalFetched: records.length,
					requestUrl: `${NANET_DETAIL_CONFIG.baseUrl}${endpoint}`,
					totalCount: records.length,
					candidate: `losi:${endpoint}`
				}
			};
		} catch (error) {
			lastError = error;
			console.error(`[NANET] LOSI endpoint 실패: ${endpoint} name=${error?.name} message=${error?.message}`);
		}
	}

	if (lastError) {
		throw lastError;
	}

	return {
		data: [],
		meta: {
			totalFetched: 0,
			requestUrl: `${NANET_DETAIL_CONFIG.baseUrl}/articleSearch`,
			totalCount: 0,
			candidate: 'losi:none'
		}
	};
}