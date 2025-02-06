// ==UserScript==
// @name         B站全场景优质视频标记(完整版)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  支持主页、搜索页、视频推荐的优质视频标记
// @author       Deepseek R1 & Claude3.5s
// @match        *://www.bilibili.com/*
// @match        *://search.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      bilibili.com
// @run-at       document-start
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
        DEBOUNCE_TIME: 200
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
            this.initScrollHandler();
        }

        initScrollHandler() {
            let timeout;
            window.addEventListener('scroll', () => {
                clearTimeout(timeout);
                timeout = setTimeout(() => this.checkNewCards(), CONFIG.DEBOUNCE_TIME);
            }, { signal: this.abortController.signal });
        }

        checkNewCards() {
            document.querySelectorAll('.bili-video-card:not([data-quality-checked]), .video-page-card-small:not([data-quality-checked])')
                   .forEach(card => this.processCard(card));
        }

        async processCard(card) {
            if (card.dataset.qualityChecked) return;
            card.dataset.qualityChecked = "processing";

            const link = card.querySelector('a[href*="/video/BV"]');
            if (!link) return;

            const bvid = this.extractBVID(link.href);
            if (!bvid) return;

            const container = this.findBadgeContainer(card);
            if (!container) return;

            const loader = this.createLoader();
            container.prepend(loader);

            try {
                const stats = await this.fetchWithRetry(bvid);
                if (this.isHighQuality(stats)) {
                    container.prepend(this.createBadge(stats));
                }
            } catch (error) {
                console.debug('[BiliMarker] API请求失败:', error);
            } finally {
                loader.remove();
                card.dataset.qualityChecked = "true";
            }
        }

        findBadgeContainer(card) {
            if (card.classList.contains('video-page-card-small')) {
                return card.querySelector('.pic-box');
            }
            return card.querySelector('.bili-video-card__cover, .cover, .pic, .bili-video-card__info') ||
                   card.closest('.bili-video-card')?.querySelector('.bili-video-card__cover');
        }

        isHighQuality(stats) {
            return stats?.view >= CONFIG.MIN_VIEWS && stats.like / stats.view >= CONFIG.MIN_SCORE;
        }

        createLoader() {
            const loader = document.createElement('span');
            loader.textContent = CONFIG.LOADING_ICON;
            loader.style.cssText = 'color:#999;margin-right:8px;position:absolute;left:8px;top:8px;z-index:1;';
            return loader;
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

            const controller = new AbortController();
            const promise = new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
                    signal: controller.signal,
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
                                this.fetchWithRetry(bvid, retry + 1).then(resolve).catch(reject);
                            } else {
                                reject(error);
                            }
                        }
                    },
                    onerror: () => {
                        if (retry < CONFIG.RETRY_LIMIT) {
                            this.fetchWithRetry(bvid, retry + 1).then(resolve).catch(reject);
                        } else {
                            reject(new Error('Request failed'));
                        }
                    }
                });
            });

            this.pendingRequests.set(bvid, promise);
            return promise.finally(() => {
                controller.abort();
                this.pendingRequests.delete(bvid);
            });
        }

        initObserver() {
            this.observer = new MutationObserver(mutations => {
                mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const cards = node.matches('.bili-video-card, .video-page-card-small') ?
                                       [node] :
                                       Array.from(node.querySelectorAll('.bili-video-card, .video-page-card-small'));
                            cards.forEach(card => this.processCard(card));
                        }
                    });
                });
            });

            this.observer.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: false,
                characterData: false
            });
        }

        start() {
            this.initObserver();
            this.checkNewCards();
            setInterval(() => this.checkNewCards(), 3000);
        }

        destroy() {
            this.observer?.disconnect();
            this.abortController.abort();
        }
    }

    class SearchResultProcessor extends VideoProcessor {
        findBadgeContainer(card) {
            return card.querySelector('.bili-video-card__cover, .imgbox') ||
                   card.closest('.bili-video-card')?.querySelector('.bili-video-card__cover');
        }

        processCard(card) {
            if (card.matches('.video-card')) {
                const wrapper = card.closest('.bili-video-card');
                if (wrapper && !wrapper.dataset.qualityChecked) {
                    super.processCard(wrapper);
                }
            } else {
                super.processCard(card);
            }
        }
    }

    let processor = null;

    window.addEventListener('load', () => {
        processor = location.host.includes('search') ?
            new SearchResultProcessor() :
            new VideoProcessor();

        processor.start();

        // 强制重新检查初始内容
        setTimeout(() => processor.checkNewCards(), 1500);
    }, { once: true });

    // 页面跳转时清理资源
    window.addEventListener('beforeunload', () => {
        processor?.destroy();
    });
})();
