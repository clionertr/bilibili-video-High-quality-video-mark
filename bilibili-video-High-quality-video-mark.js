// ==UserScript==
// @name         B站全场景优质视频标记(完整版)
// @namespace    http://tampermonkey.net/
// @version      4.2
// @description  支持主页、搜索页、视频推荐的优质视频标记
// @author       Deepseek R1 & Claude3.5s
// @match        *://www.bilibili.com/*
// @match        *://search.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      bilibili.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        MIN_SCORE: 0.042,
        MIN_VIEWS: 1000,
        TAG_COLOR: 'linear-gradient(135deg, #FF6B6B, #FF4D4D)',
        TAG_TEXT: '🔥 精选',
        LOADING_ICON: '⏳',
        RETRY_LIMIT: 3,
        DEBOUNCE_TIME: 200,
        INIT_DELAY: 2000, // 初始化延迟
        CHECK_INTERVAL: 3000 // 检查间隔
    };

    GM_addStyle(`
        .bili-quality-tag {
            display: inline-flex !important;
            align-items: center;
            background: ${CONFIG.TAG_COLOR} !important;
            color: white !important;
            padding: 3px 10px !important;
            border-radius: 15px !important;
            margin-right: 10px !important;
            font-size: 12px !important;
            animation: badgeSlideIn 0.3s ease-out !important;
            position: relative;
            z-index: 2;
        }
        .video-page-card-small .bili-quality-tag,
        .bili-video-card__wrap .bili-quality-tag {
            position: absolute;
            left: 8px;
            top: 8px;
            transform: scale(0.9);
        }
        @keyframes badgeSlideIn {
            0% { opacity: 0; transform: translateX(-15px); }
            100% { opacity: 1; transform: translateX(0); }
        }
    `);

    class VideoProcessor {
        constructor() {
            this.observer = null;
            this.pendingRequests = new Map();
            this.abortController = new AbortController();
            this.processQueue = new Set();
            this.isProcessing = false;
        }

        initScrollHandler() {
            let timeout;
            window.addEventListener('scroll', () => {
                clearTimeout(timeout);
                timeout = setTimeout(() => this.checkNewCards(), CONFIG.DEBOUNCE_TIME);
            }, { signal: this.abortController.signal });
        }

        checkNewCards() {
            if (document.visibilityState === 'hidden') return;

            const cards = document.querySelectorAll(`
                .bili-video-card:not([data-quality-checked]),
                .video-page-card-small:not([data-quality-checked]),
                .video-page-card:not([data-quality-checked])
            `);

            cards.forEach(card => {
                if (!card.dataset.qualityChecked) {
                    this.processQueue.add(card);
                }
            });

            this.processNextBatch();
        }

        async processNextBatch() {
            if (this.isProcessing || this.processQueue.size === 0) return;

            this.isProcessing = true;
            const batchSize = 5;
            const batch = Array.from(this.processQueue).slice(0, batchSize);

            try {
                await Promise.all(batch.map(card => this.processCard(card)));
            } catch (error) {
                console.debug('[BiliMarker] Batch processing error:', error);
            }

            batch.forEach(card => this.processQueue.delete(card));
            this.isProcessing = false;

            if (this.processQueue.size > 0) {
                setTimeout(() => this.processNextBatch(), 100);
            }
        }

        async processCard(card) {
            if (card.dataset.qualityChecked === 'true') return;
            if (!document.body.contains(card)) return;

            card.dataset.qualityChecked = 'processing';

            const link = card.querySelector('a[href*="/video/BV"]');
            if (!link) {
                card.dataset.qualityChecked = 'true';
                return;
            }

            const bvid = this.extractBVID(link.href);
            if (!bvid) {
                card.dataset.qualityChecked = 'true';
                return;
            }

            const container = this.findBadgeContainer(card);
            if (!container) {
                card.dataset.qualityChecked = 'true';
                return;
            }

            try {
                const stats = await this.fetchWithRetry(bvid);
                if (!document.body.contains(card)) return;

                if (this.isHighQuality(stats)) {
                    const badge = this.createBadge(stats);
                    const existingBadge = container.querySelector('.bili-quality-tag');
                    if (!existingBadge) {
                        if (container.firstChild) {
                            container.insertBefore(badge, container.firstChild);
                        } else {
                            container.appendChild(badge);
                        }
                    }
                }
            } catch (error) {
                console.debug('[BiliMarker] API请求失败:', error);
            } finally {
                if (document.body.contains(card)) {
                    card.dataset.qualityChecked = 'true';
                }
            }
        }

        findBadgeContainer(card) {
            if (card.classList.contains('video-page-card-small')) {
                return card.querySelector('.pic-box');
            }
            if (card.classList.contains('video-page-card')) {
                return card.querySelector('.pic');
            }
            return card.querySelector('.bili-video-card__cover, .cover, .pic, .bili-video-card__info') ||
                   card.closest('.bili-video-card')?.querySelector('.bili-video-card__cover');
        }

        isHighQuality(stats) {
            return stats?.view >= CONFIG.MIN_VIEWS && stats.like / stats.view >= CONFIG.MIN_SCORE;
        }

        createBadge(stats) {
            const badge = document.createElement('span');
            badge.className = 'bili-quality-tag';
            badge.innerHTML = `<span>${(stats.like/stats.view*100).toFixed(1)}%</span>${CONFIG.TAG_TEXT}`;
            return badge;
        }

        extractBVID(url) {
            try {
                return new URL(url).pathname.match(/video\/(BV\w+)/)?.[1];
            } catch {
                return null;
            }
        }

        async fetchWithRetry(bvid, retry = 0) {
            if (this.pendingRequests.has(bvid)) {
                return this.pendingRequests.get(bvid);
            }

            const promise = new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
                    timeout: 5000,
                    onload: (res) => {
                        try {
                            const data = JSON.parse(res.responseText);
                            if (data?.code === 0 && data?.data?.stat) {
                                resolve(data.data.stat);
                            } else {
                                reject(new Error('Invalid API response'));
                            }
                        } catch (error) {
                            if (retry < CONFIG.RETRY_LIMIT) {
                                setTimeout(() => {
                                    this.fetchWithRetry(bvid, retry + 1).then(resolve).catch(reject);
                                }, 1000 * (retry + 1));
                            } else {
                                reject(error);
                            }
                        }
                    },
                    onerror: () => {
                        if (retry < CONFIG.RETRY_LIMIT) {
                            setTimeout(() => {
                                this.fetchWithRetry(bvid, retry + 1).then(resolve).catch(reject);
                            }, 1000 * (retry + 1));
                        } else {
                            reject(new Error('Request failed'));
                        }
                    }
                });
            });

            this.pendingRequests.set(bvid, promise);
            return promise.finally(() => {
                this.pendingRequests.delete(bvid);
            });
        }

        initObserver() {
            this.observer = new MutationObserver((mutations) => {
                let shouldCheck = false;
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length > 0) {
                        shouldCheck = true;
                        break;
                    }
                }
                if (shouldCheck) {
                    this.checkNewCards();
                }
            });

            this.observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        start() {
            // 等待一段时间后再初始化，确保 Vue 组件已经完成渲染
            setTimeout(() => {
                this.initScrollHandler();
                this.initObserver();
                this.checkNewCards();
            }, CONFIG.INIT_DELAY);
        }

        destroy() {
            this.observer?.disconnect();
            this.abortController.abort();
            this.processQueue.clear();
            this.pendingRequests.clear();
        }
    }

    class SearchResultProcessor extends VideoProcessor {
        findBadgeContainer(card) {
            return card.querySelector('.bili-video-card__cover, .imgbox') ||
                   card.closest('.bili-video-card')?.querySelector('.bili-video-card__cover');
        }
    }

    let processor = null;

    // 等待页面完全加载后再初始化
    if (document.readyState === 'complete') {
        initProcessor();
    } else {
        window.addEventListener('load', initProcessor, { once: true });
    }

    function initProcessor() {
        processor = location.host.includes('search') ?
            new SearchResultProcessor() :
            new VideoProcessor();

        processor.start();
    }

    // 页面跳转时清理资源
    window.addEventListener('beforeunload', () => {
        processor?.destroy();
    });
})();
