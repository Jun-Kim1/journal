const {
	NOVELTY_THRESHOLDS,
	ANALYSIS_STOP_WORDS,
	NOVELTY_LABELS
} = require('./constants');

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
		const filteredKeywords = (record.keywords || []).filter((kw) => !ANALYSIS_STOP_WORDS.has(String(kw).toLowerCase()));
		const keywordScore = overlapScoreForAnalysis(topicTokens, tokenizeForAnalysis(filteredKeywords.join(' ')));
		const abstractScore = overlapScoreForAnalysis(topicTokens, tokenizeForAnalysis(record.abstract));
		const sourceWeight = (record.source === 'Global Journal' || record.source === 'Pre-print') ? 1.03 : 1;
		const citationBoost = cfg.useCitationBoost && record.citationCount > 0
			? Math.min(1.05, 1 + Math.log1p(record.citationCount) / 100)
			: 1.0;
		const similarity = clampRange((titleScore * 0.52 + keywordScore * 0.33 + abstractScore * 0.15) * sourceWeight * citationBoost, 0, 1);
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
	if (S_mixed >= NOVELTY_THRESHOLDS.P_S_HIGH_START) {
		P_S = Math.max(0, NOVELTY_THRESHOLDS.P_S_MIN_AT_HIGH - (5 * (S_mixed - NOVELTY_THRESHOLDS.P_S_HIGH_START)));
	} else if (S_mixed >= NOVELTY_THRESHOLDS.P_S_MID_START) {
		P_S = 1 - (((S_mixed - NOVELTY_THRESHOLDS.P_S_MID_START) / (NOVELTY_THRESHOLDS.P_S_HIGH_START - NOVELTY_THRESHOLDS.P_S_MID_START)) ** 2);
	}

	const similarPapersForT = scored.filter((paper) => Number(paper.similarity || 0) >= 0.5);
	const recentThreshold = now - 3;
	const C_recent = similarPapersForT.filter((paper) => paper.year && paper.year >= recentThreshold).length;
	const C_total = similarPapersForT.length;
	let T = 0.85;
	if (C_total > 0) {
		const T_raw = Math.exp(-2 * (C_recent / C_total));
		const T_min = Math.exp(-2);
		T = clampRange((T_raw - T_min) / (1 - T_min), 0, 1);
	}

	const queryKeywords = dedupeStringArray([...(queryPack.coreKeywordsEn || []), ...(queryPack.coreKeywordsKo || [])]).filter((kw) => !ANALYSIS_STOP_WORDS.has(String(kw).toLowerCase()));
	const K = computePmiKeywordRarity(queryKeywords, relevant);
	const confidence = calculateConfidence(queryPack, relevant);
	const N_raw = clampRange(100 * ((0.5 * P_S) + (0.3 * T) + (0.2 * K)), 0, 100);
	const PENALTY_CAP = 50;
	const noveltyScore = Math.round(clampRange((relevant.length ? ((N_raw * confidence) + (PENALTY_CAP * (1 - confidence))) : PENALTY_CAP), 0, 100) * 10) / 10;

	const topAvg = averageNumbers(topPapers.map((item) => Number(item.similarity || 0)));
	const highSimilarityShare = relevant.length ? relevant.filter((item) => Number(item.similarity || 0) >= 0.45).length / relevant.length : 0;
	const recentShare = relevant.length ? relevant.filter((item) => item.year && item.year >= now - 4).length / relevant.length : 0;
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
	const recommendedKciJournals = buildRecommendedKciJournals(topPapers);
	const expectedCitationIndex = Math.round((averageNumbers(topPapers.map((paper) => Number(paper.citationCount || 0))) * 0.72) + (noveltyScore * 0.38));
	const rankedSimilarPapers = rankSimilarPapersForAnalysis(relevant, now, 20);
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
		recommendedKciJournals,
		scoreBreakdown,
		gapAnalysis,
		reportNarrative,
		subScores,
		rationale,
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
	return Array.from(new Set(String(text || '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, ' ')
		.split(/\s+/)
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
	averageNumbers,
	clampRange,
	buildRecommendedKciJournals,
	buildAnalysisInsight
};
