// ==UserScript==
// @name         B站~~全场景~~优质视频标记（完整修复版）
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  修复类继承错误，兼容~~所有视频场景~~
// @author       Deepseek R1
// @match        *://www.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      bilibili.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        MIN_SCORE: 0.05,
        MIN_VIEWS: 1000,
        TAG_COLOR: 'linear-gradient(135deg, #FF6B6B, #FF4D4D)',
        TAG_TEXT: '🔥 精选',
        LOADING_ICON: '⏳',
        RETRY_LIMIT: 3,
        DEBOUNCE_TIME: 300
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
        .video-page-card-small .bili-quality-tag {
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

    // 基类必须完整定义
    class VideoProcessor {
        constructor() {
            this.observer = null;
            this.pendingRequests = new Map();
            this.initScrollHandler();
        }

        initScrollHandler() {
            let timeout;
            window.addEventListener('scroll', () => {
                clearTimeout(timeout);
                timeout = setTimeout(() => this.checkNewCards(), CONFIG.DEBOUNCE_TIME);
            });
        }

        checkNewCards() {
            document.querySelectorAll('.bili-video-card:not([data-quality-checked])')
                   .forEach(card => this.processCard(card));
        }

        async processCard(card) {
            card.dataset.qualityChecked = "processing";
            const link = card.querySelector('a[href*="/video/BV"]');
            if (!link) return;

            const bvid = this.extractBVID(link.href);
            const titleElement = card.querySelector('.bili-video-card__info--tit, .title');
            if (!bvid || !titleElement) return;

            const loader = this.createLoader();
            titleElement.before(loader);

            try {
                const stats = await this.fetchWithRetry(bvid);
                if (stats?.view >= CONFIG.MIN_VIEWS && stats.like / stats.view >= CONFIG.MIN_SCORE) {
                    titleElement.before(this.createBadge(stats));
                }
            } finally {
                loader.remove();
                card.dataset.qualityChecked = "true";
            }
        }

        createLoader() {
            const loader = document.createElement('span');
            loader.textContent = CONFIG.LOADING_ICON;
            loader.style.cssText = 'color:#999;margin-right:8px;';
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

            const promise = new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
                    onload: (res) => {
                        try {
                            const data = JSON.parse(res.responseText);
                            data.code === 0 ? resolve(data.data.stat) : reject();
                        } catch {
                            retry < CONFIG.RETRY_LIMIT
                                ? this.fetchWithRetry(bvid, retry+1).then(resolve).catch(reject)
                                : reject();
                        }
                    },
                    onerror: () => {
                        retry < CONFIG.RETRY_LIMIT
                            ? this.fetchWithRetry(bvid, retry+1).then(resolve).catch(reject)
                            : reject();
                    }
                });
            });

            this.pendingRequests.set(bvid, promise);
            return promise.finally(() => this.pendingRequests.delete(bvid));
        }

        initObserver() {
            this.observer = new MutationObserver(mutations => {
                mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.matches('.bili-video-card, .video-page-card-small')) {
                                this.processCard(node);
                            }
                            node.querySelectorAll('.bili-video-card, .video-page-card-small').forEach(card => {
                                this.processCard(card);
                            });
                        }
                    });
                });
            });

            this.observer.observe(document.body, { childList: true, subtree: true });
        }

        start() {
            this.initObserver();
            this.checkNewCards();
            setInterval(() => this.checkNewCards(), 3000);
        }
    }

    // 扩展类必须在基类之后定义
    class EnhancedVideoProcessor extends VideoProcessor {
        processCard(card) {
            // 统一处理逻辑
            if (card.classList.contains('video-page-card-small')) {
                this.processRecommendCard(card);
            } else {
                super.processCard(card);
            }
        }

        processRecommendCard(card) {
            const link = card.querySelector('a[href*="/video/BV"]');
            if (!link) return;

            const bvid = this.extractBVID(link.href);
            const picBox = card.querySelector('.pic-box');
            if (!bvid || !picBox) return;

            const loader = this.createLoader();
            picBox.append(loader);

            this.fetchWithRetry(bvid)
                .then(stats => {
                    if (stats?.view >= CONFIG.MIN_VIEWS && stats.like / stats.view >= CONFIG.MIN_SCORE) {
                        picBox.prepend(this.createBadge(stats));
                    }
                })
                .finally(() => {
                    loader.remove();
                    card.dataset.qualityChecked = "true";
                });
        }
    }

    window.addEventListener('load', () => {
        new EnhancedVideoProcessor().start();
        // 立即扫描推荐区域
        document.querySelectorAll('.video-page-card-small').forEach(card => {
            new EnhancedVideoProcessor().processCard(card);
        });
    }, { once: true });
})();
