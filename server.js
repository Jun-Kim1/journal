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

const PAPER_TYPE_MAP = {
	'학술지': '학술지',
	'석사': '석사',
	'박사': '박사',
	'후보': '후보'
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
			setCorsHeaders(res);
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
				sources: ['KCI', 'NANET', 'Global Journal', 'Pre-print'],
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

		if (req.method === 'POST' && requestUrl.pathname === '/api/arxiv/search') {
			const body = await readJsonBody(req);
			const topic = String(body.topic || '').trim();
			if (!topic) {
				throw createError(400, '검색할 주제를 입력하세요.');
			}

			const rangeYears = clampNumber(body.rangeYears, 5, 3, 15);
			const currentYear = new Date().getFullYear();
			const fromYear = currentYear - rangeYears + 1;
			const untilYear = currentYear;
			const pageSize = clampNumber(body.pageSize, 40, 10, 80);
			const translatedTopic = await translateTopicToEnglish(topic);
			const result = await searchArxivPapers({
				topic,
				translatedTopic,
				fromYear,
				untilYear,
				pageSize
			});

			sendJson(res, 200, {
				ok: true,
				data: result.data,
				meta: {
					translatedTopic,
					fromYear,
					untilYear,
					preprintCount: result.data.length,
					upstream: result.meta
				}
			});
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
			const globalTypes = normalizeGlobalTypes(body.globalTypes, body.includePreprint === true);
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
	const paperTypes = Array.isArray(payload.paperTypes) && payload.paperTypes.length ? payload.paperTypes : ['학술지', '석사', '박사'];
	const serviceKey = KCI_CONFIG.defaultServiceKey;
	const serviceKeyMode = String(payload.serviceKeyMode || 'auto');
	const nanetApiKey = NANET_CONFIG.apiKey;
	const openAlexApiKey = OPENALEX_CONFIG.apiKey;
	const openAlexMailto =

	const translatedTopic = await translateTopicToEnglish(topic);
	const globalQueryTopic = buildGlobalQueryText(topic, translatedTopic);

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
		? searchOpenAlexWorks({
			topic,
			translatedTopic: globalQueryTopic,
			fromYear,
			untilYear,
			globalTypes,
			pageSize: Math.max(30, Math.round(pageSize * 0.85)),
			apiKey: openAlexApiKey,
			mailto: openAlexMailto
		})
		: Promise.resolve({
			data: [],
			meta: { skipped: true, reason: 'OpenAlex disabled by user' }
		});

	const crossrefTask = includeCrossref
		? searchCrossrefPapers({
			topic,
			translatedTopic: globalQueryTopic,
			fromYear,
			untilYear,
			pageSize: Math.max(20, Math.round(pageSize * 0.55)),
			globalTypes
		})
		: Promise.resolve({
			data: [],
			nextCursor: '',
			meta: { skipped: true, reason: 'Crossref disabled by user' }
		});

	const arxivTask = includePreprint
		? searchArxivPapers({
			topic,
			translatedTopic: globalQueryTopic,
			fromYear,
			untilYear,
			pageSize: Math.max(20, Math.round(pageSize * 0.45))
		})
		: Promise.resolve({
			data: [],
			meta: { skipped: true, reason: 'arXiv disabled by user' }
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
				arxiv: arxivResult.meta
			}
		}
	};
}

function buildAnalysisReport(cfg, records, meta) {
	const now = new Date().getFullYear();
	const minYear = now - cfg.rangeYears + 1;
	const topicTokens = tokenizeForAnalysis(cfg.topic);

	const filtered = records.filter((record) => {
		const yearOk = !record.year || record.year >= minYear;
		const fieldOk = cfg.field === 'all' || String(record.field || '').includes(cfg.field);
		const typeLabel = String(record.type || '').toLowerCase();
		const globalTypeMap = {
			'Global Journal': 'journal',
			'Pre-print': 'preprint'
		};
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
		const sourceWeight = (record.source === 'Global Journal' || record.source === 'Pre-print') ? 1.04 : 1;
		const similarity = clampRange((titleScore * 0.52 + keywordScore * 0.33 + abstractScore * 0.15) * sourceWeight, 0, 1);
		return { ...record, similarity };
	});

	const relevant = scored.filter((record) => record.similarity >= 0.08 || includesLooseMatchForAnalysis(cfg.topic, record));
	const sorted = sortRecordsForAnalysis(relevant, cfg.sortOrder);
	const topPapers = sorted.slice(0, 12);
	const topAvg = averageNumbers(topPapers.map((item) => item.similarity));
	const highSimilarityShare = relevant.length ? relevant.filter((item) => item.similarity >= 0.45).length / relevant.length : 0;
	const recentWindow = Math.min(cfg.rangeYears, 5);
	const recentCount = relevant.filter((item) => item.year && item.year >= now - (recentWindow - 1)).length;
	const recentShare = relevant.length ? recentCount / relevant.length : 0;
	const globalShare = relevant.length ? relevant.filter((item) => item.source === 'Global Journal' || item.source === 'Pre-print').length / relevant.length : 0;
	const yearDist = buildAnalysisYearDistribution(relevant, minYear, now);
	const keywordFreq = extractKeywordFrequencyForAnalysis(relevant, topicTokens);
	const scarcityScore = computeScarcityScore(relevant, topicTokens);
	const overlapPenalty = clampRange((topAvg * 58) + (highSimilarityShare * 18), 0, 82);
	const recencyPenalty = recentShare * 22 * cfg.recentWeight;
	const saturationPenalty = Math.min(18, Math.log2(relevant.length + 1) * 4.2);
	const diversityBonus = 8 * computeDistributionEntropy(yearDist.map((entry) => entry.count));
	const globalCoverageBonus = globalShare * 6;
	const scarcityBonus = scarcityScore * 18;

	const noveltyScore = clampRange(
		100 - overlapPenalty - recencyPenalty - saturationPenalty + diversityBonus + globalCoverageBonus + scarcityBonus,
		3,
		99
	);

	const verdict = classifyNovelty(noveltyScore);
	const translatedTopic = meta.globalQueryTopic || meta.translatedTopic || cfg.topic;
	const domesticCount = meta.domesticCount || 0;
	const globalCount = meta.globalCount || 0;
	const rationale = buildNoveltyRationale({ noveltyScore, topAvg, recentShare, scarcityScore, highSimilarityShare, domesticCount, globalCount });

	return {
		noveltyScore,
		verdict,
		verdictTone: verdict.tone,
		verdictLabel: verdict.label,
		verdictSummary: verdict.summary,
		topAvg,
		topPapers,
		recentShare,
		yearDist,
		keywordFreq,
		domesticCount,
		globalCount,
		translatedTopic,
		reportScope: `최근 ${cfg.rangeYears}년 기준 · 총 ${relevant.length}건 분석`,
		sourceSummary: `KCI ${domesticCount}건 · 해외 저널 ${relevant.filter((item) => item.source === 'Global Journal').length}건 · preprint ${relevant.filter((item) => item.source === 'Pre-print').length}건`,
		matchCount: relevant.length,
		highSimilarityShare,
		scarcityScore,
		scoreBreakdown: {
			similarity: Math.round((1 - topAvg) * 100),
			trend: Math.round((1 - recentShare) * 100),
			scarcity: Math.round(scarcityScore * 100)
		},
		rationale,
		insight: buildAnalysisInsight({ noveltyScore, recentShare, topAvg, domesticCount, globalCount, translatedTopic, keywordFreq, yearDist, highSimilarityShare, scarcityScore })
	};
}

function handleSourceFailure(sourceName, error, warnings) {
	let message = '데이터 소스 연결에 문제가 있습니다.';
	if (sourceName === 'KCI') {
		message = '국내 KCI 데이터 연결에 문제가 있어 해외 논문 중심으로 결과를 제공합니다.';
	} else if (sourceName === 'NANET') {
		message = '국회도서관(NANET) 연결에 문제가 있어 다른 데이터 소스로 결과를 제공합니다.';
	} else if (sourceName === 'OpenAlex') {
		message = 'OpenAlex 연결에 문제가 있어 보조 소스 중심으로 결과를 제공합니다.';
	} else if (sourceName === 'Crossref') {
		message = '해외 Crossref 데이터 연결에 문제가 있어 국내 KCI 결과 중심으로 제공합니다.';
	} else if (sourceName === 'arXiv') {
		message = 'arXiv 프리프린트 연결에 문제가 있어 저널 데이터 중심으로 결과를 제공합니다.';
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
	const arxivId = normalizeArxivIdentifier(ids.arxiv || '');

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
		source: type === 'Pre-print' ? 'Pre-print' : 'Global Journal',
		language: 'en',
		openalexId: String(record.id || '').trim(),
		arxivId
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
	if (rawType === 'preprint') {
		return 'Pre-print';
	}
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
	if (globalTypes.includes('preprint')) {
		mapped.push('preprint');
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
	const allowed = ['journal', 'master', 'doctor', 'preprint'];
	const normalized = incoming.filter((item) => allowed.includes(item));
	if (!normalized.length) {
		normalized.push('journal', 'master', 'doctor');
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

function setCorsHeaders(res) {
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