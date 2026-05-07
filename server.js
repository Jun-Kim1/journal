const http = require('http');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_FILE = path.join(__dirname, 'journal.html');
const CROSSREF_MAILTO = 'huhuhu1013@naver.com';
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
		if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
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

	const includeKci = true; // 항상 모든 소스 수집
	const includeCrossref = true;
	const globalTypes = ['journal', 'preprint'];
	const includePreprint = true;

	const rangeYears = clampNumber(payload.rangeYears, 5, 3, 15);
	const currentYear = new Date().getFullYear();
	const fromYear = currentYear - rangeYears + 1;
	const untilYear = currentYear;
	const pageSize = clampNumber(payload.pageSize, 80, 20, 200);
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
	
	console.log(`[sources] KCI: ${kciResult.data ? kciResult.data.length : 0}, NANET: ${nanetResult.data ? nanetResult.data.length : 0}, OpenAlex: ${openAlexResult.data ? openAlexResult.data.length : 0}, Crossref: ${crossrefResult.data ? crossrefResult.data.length : 0}, arXiv: ${arxivResult.data ? arxivResult.data.length : 0}`);
	if (warnings.length > 0) {
		console.log('[sources] Warnings:', warnings);
	}
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
		paperTypes: paperTypes,
		globalTypes: globalTypesResult,
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
	
	// 병렬로 전부 실행하되, timeout으로 빠르게 실패하게 함
	const [translatedTopic, coreKeywordsKo] = await Promise.all([
		translateTopicToEnglish(primaryQueryKo),
		Promise.resolve(extractCoreKeywords(primaryQueryKo))
	]);
	
	const baseEnglishQuery = buildGlobalQueryText(primaryQueryKo, translatedTopic);
	const expansionTargets = coreKeywordsKo.slice(0, 2); // 최대 2개만 확장
	
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
	
	const coreKeywordsEn = dedupeStringArray(keywordExpansions.flatMap((item) => [
		...(item.synonyms || []).slice(0, 1),
		...(item.entities || []).slice(0, 1),
		item.fallbackTranslation || ''
	]));

	const primaryQueryEn = dedupeStringArray([
		...tokenizeEnglish(baseEnglishQuery),
		...coreKeywordsEn.flatMap((item) => String(item).split(/\s+/))
	]).slice(0, 24).join(' ') || baseEnglishQuery || primaryQueryKo;

	// 확장 쿼리 생성을 단순화
	const expandedQueries = [];
	for (const expansion of keywordExpansions.slice(0, 1)) {
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
		coreKeywordsKo: coreKeywordsKo.slice(0, 2),
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

	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(8000) // 20초 → 8초
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