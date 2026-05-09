const {
	NOVELTY_THRESHOLDS,
	ANALYSIS_STOP_WORDS,
	NOVELTY_LABELS
} = require('./constants');

const SIMILARITY_THRESHOLD = 0.65;
const PRIORITY_KEYWORDS = [
	'self-efficacy', 'self efficacy', 'self-confidence',
	'programmer', 'developer', 'software engineer',
	'psychological', 'empowerment', 'confidence'
];

function buildAnalysisReport(cfg, records, meta) {
	const now = new Date().getFullYear();
	const minYear = now - cfg.rangeYears + 1;
	const queryPack = meta.queryPack || {
		coreKeywordsKo: tokenizeForAnalysis(cfg.topic),
		coreKeywordsEn: []
	};
	// Score with both original topic and expanded English query to avoid losing Korean domain intent.
	const scoringTopic = meta.globalQueryTopic || meta.translatedTopic || cfg.topic;
	const originalTopicTokens = tokenizeForAnalysis(cfg.topic);
	const expandedTopicTokens = tokenizeForAnalysis(scoringTopic);
	const topicTokens = dedupeStringArray([...originalTopicTokens, ...expandedTopicTokens]);
	const domainSignals = buildDomainSignals(queryPack, cfg.topic, scoringTopic);

	// 필터 없이 연도 범위만 적용 (소스/타입 필터 제거 - 모든 API 결과 포함)
	const filtered = records.filter((record) => {
		const yearOk = !record.year || record.year >= minYear;
		return yearOk;
	});

	const rawScored = filtered.map((record) => {
		const titleScore = overlapScoreForAnalysis(topicTokens, tokenizeForAnalysis(record.title));
		const filteredKeywords = (record.keywords || []).filter((kw) => !ANALYSIS_STOP_WORDS.has(String(kw).toLowerCase()));
		const keywordScore = overlapScoreForAnalysis(topicTokens, tokenizeForAnalysis(filteredKeywords.join(' ')));
		const abstractScore = overlapScoreForAnalysis(topicTokens, tokenizeForAnalysis(record.abstract));
		const domainBoost = computeDomainBoostForRecord(record, domainSignals);
		const sourceWeight = (record.source === 'Global Journal' || record.source === 'Pre-print') ? 1.03 : 1;
		const citationBoost = cfg.useCitationBoost && record.citationCount > 0
			? Math.min(1.05, 1 + Math.log1p(record.citationCount) / 100)
			: 1.0;
		// Concept coverage multiplier: papers missing key concepts (e.g. AI-only, no self-efficacy)
		// get penalized so they rank below papers covering all required concepts.
		const conceptCovMult = computeConceptCoverageMultiplier(record, domainSignals);
		const rawSimilarity = clampRange((titleScore * 0.48 + keywordScore * 0.30 + abstractScore * 0.14 + domainBoost * 0.08) * sourceWeight * citationBoost * conceptCovMult, 0, 1);
		// fullUrl: doi 우선, url fallback
		const doi = record.doi || '';
		const fullUrl = doi ? (doi.startsWith('http') ? doi : `https://doi.org/${doi}`) : (record.url || '');
		return { ...record, rawSimilarity, doi, fullUrl };
	});

	const scored = normalizeSimilarityScores(rawScored);

	const requestedThreshold = Number(cfg && cfg.similarityThreshold);
	const relevanceThreshold = Number.isFinite(requestedThreshold)
		? clampRange(requestedThreshold, 0.5, 0.9)
		: SIMILARITY_THRESHOLD;
	let relevant = scored.filter((record) => {
		const similarityPass = Number(record.similarity || 0) >= relevanceThreshold;
		const loosePass = includesLooseMatchForAnalysis(scoringTopic, record);
		if (!domainSignals.hasAny) {
			return similarityPass || loosePass;
		}
		const domainPass = hasRequiredDomainEvidence(record, domainSignals);
		return (similarityPass || loosePass) && domainPass;
	});

	// If relevance filters are too strict, keep a broader affinity-ranked pool
	// to avoid returning only 0-2 papers for broad Korean queries.
	// But still prefer papers that cover the required domain concepts (concept coverage multiplier
	// is already baked into similarity scores, so sorting by similarity still respects it).
	if (relevant.length < Math.min(20, Math.max(8, Math.round(scored.length * 0.2)))) {
		relevant = [...scored]
			.sort((a, b) => Number(b.similarity || 0) - Number(a.similarity || 0))
			.slice(0, Math.min(80, scored.length));
	}
	const sorted = sortRecordsForAnalysis(relevant, cfg.sortOrder);
	const topPapers = sorted.slice(0, 20);
	const similarities = topPapers.map((item) => Number(item.similarity || 0)).sort((a, b) => b - a);
	const S_max = similarities[0] || 0;
	const S_top5_avg = averageNumbers(similarities.slice(0, 5));
	const S_mixed = (0.6 * S_max) + (0.4 * S_top5_avg);

	// --- 엄격한 유사도 페널티: Exponential Decay ---
	// S_max >= 0.7 → 즉시 P_S 크게 깎음 (30~40점대 가능)
	// S_max >= 0.5 → 중간 페널티
	// S_max < 0.3 → 페널티 거의 없음
	let P_S;
	if (S_max >= 0.7) {
		// 매우 유사한 논문 발견 → 지수 붕괴
		P_S = Math.max(0.05, Math.exp(-6 * (S_max - 0.5)));
	} else if (S_max >= 0.5) {
		// 상당히 유사 → 강한 페널티
		P_S = Math.max(0.1, 1 - (2.5 * (S_max - 0.3) ** 1.4));
	} else if (S_max >= 0.3) {
		// 중간 유사 → 선형 감소
		P_S = clampRange(1 - (1.8 * (S_max - 0.3)), 0.35, 1.0);
	} else {
		// 낮은 유사도 → Top5 평균도 반영
		P_S = clampRange(1 - (S_mixed * 0.8), 0.6, 1.0);
	}
	// 상위 3개 논문 중 1개라도 0.6+ 이면 추가 페널티
	const top3Count = similarities.slice(0, 3).filter((s) => s >= 0.6).length;
	if (top3Count >= 2) P_S = Math.min(P_S, 0.25);
	else if (top3Count === 1) P_S = Math.min(P_S, 0.45);

	const similarPapersForT = scored.filter((paper) => Number(paper.similarity || 0) >= 0.2);
	const recentThreshold = now - 3;
	const C_recent = similarPapersForT.filter((paper) => paper.year && paper.year >= recentThreshold).length;
	const C_total = similarPapersForT.length;
	let T = 0.85;
	if (C_total > 0) {
		const ratio = C_recent / C_total;
		// 최근 논문이 많을수록 T 낮아짐 (더 넓은 범위로 페널티)
		// ratio=0.8 → T≈0.06, ratio=0.5 → T≈0.37, ratio=0.2 → T≈0.72
		const T_raw = Math.exp(-3.5 * ratio);
		// 유사 논문 총 갯수가 많을수록 추가 페널티
		const volumePenalty = C_total >= 15 ? 0.85 : C_total >= 8 ? 0.92 : 1.0;
		T = clampRange(T_raw * volumePenalty, 0, 1);
	}

	const queryKeywords = dedupeStringArray([...(queryPack.coreKeywordsEn || []), ...(queryPack.coreKeywordsKo || [])]).filter((kw) => !ANALYSIS_STOP_WORDS.has(String(kw).toLowerCase()));
	const K = computePmiKeywordRarity(queryKeywords, relevant);
	const confidence = calculateConfidence(queryPack, relevant);

	// 더 엄격한 N_raw: 관련 논문이 매우 많으면 추가 페널티
	const volumeScorePenalty = relevant.length >= 30 ? 0.80 : relevant.length >= 20 ? 0.90 : 1.0;
	const N_raw = clampRange(100 * ((0.5 * P_S) + (0.3 * T) + (0.2 * K)) * volumeScorePenalty, 0, 100);

	// 낮은 신뢰도 시 페널티 상한을 높여 점수가 너무 상승하지 않도록
	const PENALTY_CAP = relevant.length > 5 ? 42 : 50;
	const noveltyScore = Math.round(clampRange((relevant.length ? ((N_raw * confidence) + (PENALTY_CAP * (1 - confidence))) : PENALTY_CAP), 0, 100) * 10) / 10;

	// 계산 근거 텍스트
	const calculationLogic = `유사도 페널티(P_S=${P_S.toFixed(2)}, S_max=${S_max.toFixed(2)}) × 0.5 + 시계열 희소성(T=${T.toFixed(2)}, 최근${C_recent}/${C_total}건) × 0.3 + 키워드 희소성(K=${K.toFixed(2)}) × 0.2 → N_raw=${N_raw.toFixed(1)}, 신뢰도=${(confidence*100).toFixed(0)}%, 최종=${noveltyScore}점`;

	const topAvg = averageNumbers(topPapers.map((item) => Number(item.similarity || 0)));
	const highSimilarityShare = relevant.length ? relevant.filter((item) => Number(item.similarity || 0) >= 0.45).length / relevant.length : 0;
	const recentShare = relevant.length ? relevant.filter((item) => item.year && item.year >= now - 4).length / relevant.length : 0;
	// 실제 3년 증가율: 최근 3년(now-2 ~ now) vs 이전 3년(now-5 ~ now-3)
	const recent3Count = relevant.filter((p) => p.year && p.year >= now - 2).length;
	const prior3Count = relevant.filter((p) => p.year && p.year >= now - 5 && p.year < now - 2).length;
	const trendGrowthRate = prior3Count > 0
		? Math.round(((recent3Count - prior3Count) / prior3Count) * 100)
		: (recent3Count > 0 ? Math.min(300, recent3Count * 20) : 0);
	const yearDist = buildAnalysisYearDistribution(relevant, minYear, now);
	const keywordFreq = extractKeywordFrequencyForAnalysis(relevant, topicTokens).filter((kw) => !ANALYSIS_STOP_WORDS.has(String(kw.keyword).toLowerCase()));
	const scarcityScore = computeScarcityScore(relevant, topicTokens);
	const creativityScore = computeCombinationalCreativity(cfg.topic, relevant, keywordFreq);
	const verdict = classifyNovelty(noveltyScore, S_max);
	const translatedTopic = meta.globalQueryTopic || meta.translatedTopic || cfg.topic;
	const domesticCount = relevant.filter((item) => item.source === 'KCI').length;
	const globalJournalCount = relevant.filter((item) => item.source === 'Global Journal').length;
	const preprintCount = relevant.filter((item) => item.source === 'Pre-print').length;
	const globalCount = globalJournalCount + preprintCount;
	const rationale = buildNoveltyRationale({ noveltyScore, topAvg, recentShare, scarcityScore, highSimilarityShare, domesticCount, globalCount });
	const recommendedJournals = buildRecommendedJournals(relevant);
	const recommendedKciJournals = recommendedJournals; // backwards compat
	const expectedCitationIndex = Math.round((averageNumbers(topPapers.map((paper) => Number(paper.citationCount || 0))) * 0.72) + (noveltyScore * 0.38));
	const rankedSimilarPapers = rankSimilarPapersForAnalysis(
		relevant,
		now,
		Math.max(10, relevant.length),
		relevanceThreshold,
		{ minReturn: 10, minAllowedThreshold: 0.5 }
	);
	const searchWarning = confidence < 0.5 ? `검색 신뢰도가 낮습니다 (${Math.round(confidence * 100)}%). 쿼리 확장 또는 범위 확대를 권장합니다.` : null;

	const scoreBreakdown = {
		similarity: Math.round(P_S * 100),
		trend: Math.round(T * 100),
		scarcity: Math.round(K * 100),
		creativity: Math.round(creativityScore * 100)
	};
	const subScores = {
		similarityPenalty: { S_max, S_top5_avg, S_mixed, P_S, weight: 0.5, reason: `유사 논문 ${rankedSimilarPapers.length}건, S_max=${S_max.toFixed(2)}` },
		temporalSparsity: { C_recent, C_total, T_score: T, weight: 0.3, reason: `최근 3년 논문 ${C_recent}건 / 전체 ${C_total}건` },
		keywordRarity: { K_score: K, weight: 0.2, reason: `핵심 키워드 희귀도 ${K.toFixed(2)}` },
		confidence: { value: confidence, reason: `검색 커버리지 ${(confidence * 100).toFixed(1)}%` }
	};

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
		matchCount: relevant.length,
		scoreBreakdown,
		subScores
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
		matchCount: relevant.length,
		scoreBreakdown,
		subScores
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
		trendGrowthRate,
		trendCounts: { recent3Count, prior3Count },
		yearDist,
		keywordFreq,
		domesticCount,
		globalCount,
		preprintCount,
		translatedTopic,
		reportScope: `최근 ${cfg.rangeYears}년 기준 · 총 ${relevant.length}건 분석`,
		sourceSummary: `국내 저널 ${domesticCount}건 · 해외 저널 ${globalJournalCount}건 · 프리프린트 ${preprintCount}건`,
		matchCount: relevant.length,
		highSimilarityShare,
		scarcityScore,
		creativityScore,
		expectedCitationIndex,
		recommendedJournals,
		recommendedKciJournals,
		scoreBreakdown,
		gapAnalysis,
		reportNarrative,
		subScores,
		rationale,
		calculationLogic,
		insight: buildAnalysisInsight({ noveltyScore, recentShare, topAvg, domesticCount, globalCount, translatedTopic, keywordFreq, yearDist, highSimilarityShare, scarcityScore })
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

	const uniqueSources = new Set(papers.map((paper) => paper.source || 'unknown')).size;
	const sourceVariety = Math.min(1, uniqueSources / 3);

	const confidence = (countConfidence * 0.5) + (keywordCoverage * 0.3) + (sourceVariety * 0.2);
	return Math.round(clampRange(confidence, 0.05, 1.0) * 1000) / 1000;
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

function buildRecommendedJournals(records) {
	const journalMap = new Map();
	records
		.filter((record) => record.journal)
		.forEach((record) => {
			const key = String(record.journal).trim();
			if (!key) return;
			const current = journalMap.get(key) || { journal: key, source: record.source || '', count: 0, similarityTotal: 0, recentCount: 0 };
			current.count += 1;
			current.similarityTotal += Number(record.similarity || 0);
			if (record.year && record.year >= new Date().getFullYear() - 2) current.recentCount += 1;
			journalMap.set(key, current);
		});

	return Array.from(journalMap.values())
		.map((item) => ({
			journal: item.journal,
			source: item.source,
			count: item.count,
			recentCount: item.recentCount,
			avgSimilarity: item.count ? item.similarityTotal / item.count : 0
		}))
		.sort((a, b) => (b.count - a.count) || (b.recentCount - a.recentCount) || (b.avgSimilarity - a.avgSimilarity))
		.slice(0, 20);
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

function tokenizeForAnalysis(text) {
	const str = String(text || '').toLowerCase();
	
	// 한글 초성·중성·종성 분해 (자모 단위)
	const decomposeHangul = (char) => {
		const code = char.charCodeAt(0);
		if (code < 0xAC00 || code > 0xD7A3) return [char];
		const index = code - 0xAC00;
		const cho = Math.floor(index / 588);
		const joong = Math.floor((index % 588) / 28);
		const jong = index % 28;
		const choList = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
		const joongList = ['ㅏ', 'ㅑ', 'ㅓ', 'ㅕ', 'ㅗ', 'ㅛ', 'ㅜ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ', 'ㅤ', 'ㅥ', 'ㅦ', 'ㅧ', 'ㅨ', 'ㅩ', 'ㅪ', 'ㅫ', 'ㅬ', 'ㅭ'];
		const jongList = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
		return [choList[cho], joongList[joong], jongList[jong]].filter(Boolean);
	};
	
	const tokens = [];
	let current = '';
	for (let i = 0; i < str.length; i++) {
		const char = str[i];
		if (/[\p{L}\p{N}-]/u.test(char)) {
			current += char;
		} else if (current) {
			tokens.push(current);
			current = '';
		}
	}
	if (current) tokens.push(current);
	
	// 한글 단어는 초성/전체 조합도 추가
	const expanded = [];
	tokens.forEach((token) => {
		expanded.push(token);
		if (/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(token)) {
			let decomposed = '';
			for (let i = 0; i < token.length; i++) {
				decomposed += decomposeHangul(token[i]).join('');
			}
			if (decomposed !== token) {
				expanded.push(decomposed);
			}
		}
	});
	
	return Array.from(new Set(expanded
		.map((token) => token.trim())
		.filter((token) => token.length >= 2)
		.filter((token) => !ANALYSIS_STOP_WORDS.has(token))));
}

function overlapScoreForAnalysis(baseTokens, targetTokens) {
	if (!baseTokens.length || !targetTokens.length) return 0;
	const targetSet = new Set(targetTokens);
	const matchCount = baseTokens.filter((token) => targetSet.has(token)).length;
	const jaccard = matchCount / new Set([...baseTokens, ...targetTokens]).size;
	const recall = matchCount / baseTokens.length;
	return (jaccard * 0.5) + (recall * 0.5);
}

function includesLooseMatchForAnalysis(topic, record) {
	const topicTokens = tokenizeForAnalysis(topic);
	return topicTokens.some((token) =>
		String(record.title || '').toLowerCase().includes(token)
		|| String(record.abstract || '').toLowerCase().includes(token)
	);
}

function buildDomainSignals(queryPack, originalTopic, scoringTopic) {
	const context = [
		originalTopic || '',
		scoringTopic || '',
		...((queryPack && queryPack.coreKeywordsKo) || []),
		...((queryPack && queryPack.coreKeywordsEn) || [])
	].join(' ').toLowerCase();

	const agentKeywords = ['programmer', 'developer', 'software engineer', 'coder', 'software development', 'programming'];
	const aiKeywords = [
		'generative ai', 'artificial intelligence', 'chatgpt', 'llm', 'large language model',
		'foundation model', 'language model', '생성형', '인공지능', '대규모 언어모델'
	];
	// Removed standalone 'efficacy' and 'confidence' — these match medical/ML contexts too broadly.
	const psychologyKeywords = [
		'self-efficacy', 'self efficacy', 'academic self-efficacy', 'learning self-efficacy',
		'psychological', 'motivation', 'belief', '자기효능감', '학습 효능감'
	];

	const hasAgent = agentKeywords.some((kw) => context.includes(kw));
	const hasAi = aiKeywords.some((kw) => context.includes(kw));
	const hasPsychology = psychologyKeywords.some((kw) => context.includes(kw));
	const activeCount = [hasAgent, hasAi, hasPsychology].filter(Boolean).length;

	return {
		hasAny: hasAgent || hasAi || hasPsychology,
		requireAllActiveCategories: activeCount >= 2,
		agentKeywords,
		aiKeywords,
		psychologyKeywords,
		hasAgent,
		hasAi,
		hasPsychology
	};
}

function computeDomainBoostForRecord(record, domainSignals) {
	if (!domainSignals || !domainSignals.hasAny) {
		return 0;
	}
	const text = `${record.title || ''} ${record.abstract || ''} ${Array.isArray(record.keywords) ? record.keywords.join(' ') : ''}`.toLowerCase();
	const agentMatchCount = domainSignals.hasAgent
		? domainSignals.agentKeywords.filter((kw) => text.includes(kw)).length
		: 0;
	const aiMatchCount = domainSignals.hasAi
		? domainSignals.aiKeywords.filter((kw) => text.includes(kw)).length
		: 0;
	const psychologyMatchCount = domainSignals.hasPsychology
		? domainSignals.psychologyKeywords.filter((kw) => text.includes(kw)).length
		: 0;

	const totalRequired = (domainSignals.hasAgent ? 1 : 0) + (domainSignals.hasAi ? 1 : 0) + (domainSignals.hasPsychology ? 1 : 0);
	if (totalRequired === 0) {
		return 0;
	}
	const covered = (agentMatchCount > 0 ? 1 : 0) + (aiMatchCount > 0 ? 1 : 0) + (psychologyMatchCount > 0 ? 1 : 0);
	return clampRange(covered / totalRequired, 0, 1);
}

// Concept coverage multiplier: penalizes papers that do not cover ALL required domain concepts.
// For "생성형 AI + 자기효능감" queries, a paper with only AI keywords (no self-efficacy) gets 0.70,
// a paper with neither concept gets 0.40. Papers covering all concepts get 1.0.
// Per md spec: similarity * (0.4 + 0.6 * coverageRatio)
function computeConceptCoverageMultiplier(record, domainSignals) {
	if (!domainSignals || !domainSignals.hasAny) return 1.0;

	const text = `${record.title || ''} ${record.abstract || ''} ${Array.isArray(record.keywords) ? record.keywords.join(' ') : ''}`.toLowerCase();

	let required = 0;
	let covered = 0;

	if (domainSignals.hasAi) {
		required++;
		if (domainSignals.aiKeywords.some((kw) => text.includes(kw))) covered++;
	}
	if (domainSignals.hasPsychology) {
		required++;
		if (domainSignals.psychologyKeywords.some((kw) => text.includes(kw))) covered++;
	}
	if (domainSignals.hasAgent) {
		required++;
		if (domainSignals.agentKeywords.some((kw) => text.includes(kw))) covered++;
	}

	if (!required) return 1.0;
	const ratio = covered / required;
	return 0.4 + 0.6 * ratio;
}

function normalizeSimilarityScores(records) {
	const values = records.map((record) => Number(record.rawSimilarity || 0)).filter((v) => Number.isFinite(v));
	const max = values.length ? Math.max(...values) : 0;

	if (!values.length || max <= 0) {
		return records.map((record) => ({ ...record, similarity: 0 }));
	}

	// Scale proportionally against max (no min-max stretching).
	// Min-max stretch made irrelevant papers appear highly similar by boosting
	// the lowest-scoring paper to 0% and the highest to 100% regardless of
	// absolute relevance. Instead, use raw/max so weak matches show as low %.
	return records.map((record) => {
		const raw = Number(record.rawSimilarity || 0);
		const normalized = clampRange(raw / max, 0, 1);
		return {
			...record,
			similarity: Number(normalized.toFixed(4))
		};
	});
}

function priorityScoreForPaper(paper) {
	const text = `${paper.title || ''} ${paper.abstract || ''}`.toLowerCase();
	return PRIORITY_KEYWORDS.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0);
}

function debugSimilarityCheck(queryVector, paperVector) {
	const vecA = Array.isArray(queryVector) ? queryVector.map((v) => Number(v) || 0) : [];
	const vecB = Array.isArray(paperVector) ? paperVector.map((v) => Number(v) || 0) : [];
	if (!vecA.length || !vecB.length || vecA.length !== vecB.length) {
		return { dot: 0, normA: 0, normB: 0, cosine: 0, normalized: 0, percent: 0 };
	}

	const dot = vecA.reduce((sum, v, i) => sum + (v * vecB[i]), 0);
	const normA = Math.sqrt(vecA.reduce((sum, v) => sum + (v * v), 0));
	const normB = Math.sqrt(vecB.reduce((sum, v) => sum + (v * v), 0));
	const cosine = (normA > 0 && normB > 0) ? dot / (normA * normB) : 0;
	const normalized = clampRange((cosine + 1) / 2, 0, 1);
	return {
		dot: Number(dot.toFixed(4)),
		normA: Number(normA.toFixed(4)),
		normB: Number(normB.toFixed(4)),
		cosine: Number(cosine.toFixed(4)),
		normalized: Number(normalized.toFixed(4)),
		percent: Math.round(normalized * 100)
	};
}

function hasRequiredDomainEvidence(record, domainSignals) {
	if (!domainSignals || !domainSignals.hasAny) {
		return true;
	}
	const text = `${record.title || ''} ${record.abstract || ''} ${Array.isArray(record.keywords) ? record.keywords.join(' ') : ''}`.toLowerCase();
	const hasAgentMatch = domainSignals.hasAgent
		? domainSignals.agentKeywords.some((kw) => text.includes(kw))
		: true;
	const hasAiMatch = domainSignals.hasAi
		? domainSignals.aiKeywords.some((kw) => text.includes(kw))
		: true;
	const hasPsychologyMatch = domainSignals.hasPsychology
		? domainSignals.psychologyKeywords.some((kw) => text.includes(kw))
		: true;

	if (domainSignals.requireAllActiveCategories) {
		return hasAgentMatch && hasAiMatch && hasPsychologyMatch;
	}
	if (domainSignals.hasAgent && !domainSignals.hasAi && !domainSignals.hasPsychology) {
		return hasAgentMatch;
	}
	if (!domainSignals.hasAgent && domainSignals.hasAi && !domainSignals.hasPsychology) {
		return hasAiMatch;
	}
	if (!domainSignals.hasAgent && !domainSignals.hasAi && domainSignals.hasPsychology) {
		return hasPsychologyMatch;
	}
	return hasAgentMatch || hasAiMatch || hasPsychologyMatch;
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
			if (ANALYSIS_STOP_WORDS.has(normalized)) return;
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
	if (uniqueKeywords.length < 2) return 0.5;
	if (papers.length < 5) return 0.5;

	const corpusSize = (papers.length || 0) + 1;
	const countWith = (keyword) => papers.filter((paper) => (paper.keywords || []).some((item) => String(item).toLowerCase().includes(keyword))).length + 1;
	const countWithBoth = (left, right) => papers.filter((paper) => {
		const lowerKeywords = (paper.keywords || []).map((item) => String(item).toLowerCase());
		return lowerKeywords.some((item) => item.includes(left)) && lowerKeywords.some((item) => item.includes(right));
	}).length + 1;

	const npmiValues = [];
	for (let i = 0; i < uniqueKeywords.length; i += 1) {
		for (let j = i + 1; j < uniqueKeywords.length; j += 1) {
			const P_i = countWith(uniqueKeywords[i]) / corpusSize;
			const P_j = countWith(uniqueKeywords[j]) / corpusSize;
			const P_ij = countWithBoth(uniqueKeywords[i], uniqueKeywords[j]) / corpusSize;
			const rawPMI = Math.log2(P_ij / ((P_i * P_j) + 1e-6));
			const normFactor = -Math.log2(P_ij + 1e-6);
			const npmi = normFactor > 0 ? rawPMI / normFactor : 0;
			npmiValues.push(clampRange(npmi, -1, 1));
		}
	}

	const meanNpmi = averageNumbers(npmiValues);
	return Math.round(clampRange((1 - meanNpmi) / 2, 0, 1) * 10000) / 10000;
}

function rankSimilarPapersForAnalysis(papers, currentYear, topK, threshold = SIMILARITY_THRESHOLD, options = {}) {
	const maxCitations = Math.max(1, ...papers.map((paper) => Number(paper.citationCount || 0)));
	const minReturn = Math.max(1, Math.floor(Number(options.minReturn) || 10));
	const minAllowedThreshold = clampRange(Number(options.minAllowedThreshold || 0.5), 0, 1);
	const strictThreshold = clampRange(Number(threshold || SIMILARITY_THRESHOLD), minAllowedThreshold, 1);

	const ranked = [...papers]
		.map((paper) => {
			const age = currentYear - Number(paper.year || currentYear);
			const recency = Math.max(0, 1 - (age / 20));
			const citeNorm = Math.log1p(Number(paper.citationCount || 0)) / Math.log1p(maxCitations + 1);
			const priorityScore = priorityScoreForPaper(paper);
			const rankScore = (0.45 * Number(paper.similarity || 0)) + (0.2 * recency) + (0.2 * citeNorm) + (0.15 * Math.min(priorityScore / 4, 1));
			const doi = paper.doi || '';
			const link = paper.fullUrl || (doi ? (doi.startsWith('http') ? doi : `https://doi.org/${doi}`) : (paper.url || ''));
			return {
				...paper,
				doi,
				link,
				fullUrl: link,
				priorityScore,
				similarityPercent: Math.round(Number(paper.similarity || 0) * 100),
				rankScore: Math.round(rankScore * 10000) / 10000
			};
		})
		.sort((a, b) => (b.priorityScore - a.priorityScore) || (b.rankScore - a.rankScore));

	let filtered = ranked.filter((paper) => Number(paper.similarity || 0) >= strictThreshold);
	if (filtered.length < minReturn) {
		const relaxedThreshold = Math.max(minAllowedThreshold, strictThreshold - 0.15);
		filtered = ranked.filter((paper) => Number(paper.similarity || 0) >= relaxedThreshold);
	}

	return filtered.slice(0, topK);
}

function classifyNovelty(score) {
	return NOVELTY_LABELS.find((l) => score >= l.min) || NOVELTY_LABELS[NOVELTY_LABELS.length - 1];
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
	const topKw = keywordFreq.slice(0, 5).map((item) => item.keyword);
	const verdict = classifyNovelty(noveltyScore);

	// 참신성 평가
	const noveltyDesc = verdict.summary;

	// 유사도 수준
	const simDesc = topAvg >= 0.65
		? `상위 유사도 평균은 ${Math.round(topAvg * 100)}%로 높은 편입니다.`
		: topAvg >= 0.4
			? `상위 유사도 평균은 ${Math.round(topAvg * 100)}%입니다.`
			: `상위 유사도 평균은 ${Math.round(topAvg * 100)}%로 낮아 희소한 주제입니다.`;

	// 창신성 지수
	const scoreDesc = `창신성 지수는 ${noveltyScore}점입니다.`;

	// 검색 규모
	const countDesc = (domesticCount + globalCount) > 0
		? `총 ${domesticCount + globalCount}건 기준으로 분석했습니다.`
		: '';

	// 영문 검색어: 너무 길면 앞 6개 단어만 표시
	const enTokens = String(translatedTopic || '').split(/\s+/).filter(Boolean);
	const enShort = enTokens.slice(0, 6).join(' ');
	const enDesc = enShort
		? `영문 검색어는 "${enShort}${enTokens.length > 6 ? '…' : ''}"으로 매핑되었습니다.`
		: '';

	// 유사 논문 주요 키워드
	const kwDesc = topKw.length
		? `유사 논문에서 자주 등장한 키워드는 ${topKw.join(', ')}입니다.`
		: '';

	// 발표 피크
	const peakDesc = peak && peak.count > 0 ? `${peak.year}년에 발표량이 가장 높았습니다.` : '';

	return [noveltyDesc, simDesc, scoreDesc, countDesc, enDesc, kwDesc, peakDesc].filter(Boolean).join(' ');
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
			similarityPercent: Math.round(Number(paper.similarity || 0) * 100),
			rankScore: paper.rankScore,
			doi: paper.doi || '',
			link: paper.link || paper.fullUrl || ''
		})),
		// 동적 강점 신호 (opportunitySignals에서 생성된 실제 분석 결과)
		keySignals: opportunitySignals.length
			? opportunitySignals.slice(0, 3)
			: (scarcityScore >= 0.55
				? ['핵심 키워드 희소성이 높아 개념적 공백 진입 가능', '코퍼스 포화도가 낮아 기여 여지 존재']
				: ['세부 조건·맥락 변수로 차별화 가능성 있음'])
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

function dedupeStringArray(values) {
	return Array.from(new Set((values || []).filter(Boolean).map((item) => String(item).trim())));
}

module.exports = {
	buildAnalysisReport,
	computeCombinationalCreativity,
	calculateConfidence,
	overlapScoreForAnalysis,
	tokenizeForAnalysis,
	computePmiKeywordRarity,
	classifyNovelty,
	buildNoveltyRationale,
	buildGapAnalysisReport,
	buildSpecReportNarrative,
	extractKeywordFrequencyForAnalysis,
	computeScarcityScore,
	includesLooseMatchForAnalysis,
	sortRecordsForAnalysis,
	buildAnalysisYearDistribution,
	rankSimilarPapersForAnalysis,
	debugSimilarityCheck,
	averageNumbers,
	clampRange,
	buildRecommendedKciJournals,
	buildRecommendedJournals,
	buildAnalysisInsight
};
