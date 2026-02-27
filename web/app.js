// DNS故障切换管理系统 - 前端应用逻辑
class DNSManager {
    constructor() {
        const origin = window.location?.origin;
        this.baseURL = origin && origin !== 'null' ? origin : 'http://localhost:8081';
        this.currentZoneId = null;
        this.currentZoneName = null;
        this.monitorInterval = null;
        this.startTime = Date.now();
        this.monitorsCache = [];
        this.editingMonitorId = null;
        this.recordsCache = [];
        this.editingRecordId = null;
        this.restoreMonitorId = null;
        this.scheduleMonitorId = null;
        
        // 确保DOM完全加载后再初始化
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.checkAuthAndInit());
        } else {
            this.checkAuthAndInit();
        }
    }

    async checkAuthAndInit() {
        try {
            const response = await fetch(`${this.baseURL}/api/auth/check`);
            const result = await response.json();
            
            if (result.code === 200 && result.data) {
                // 如果需要设置或未认证，跳转到登录页
                if (result.data.need_setup || !result.data.authenticated) {
                    window.location.href = '/login.html';
                    return;
                }
            }
            
            // 认证通过，初始化应用
            this.init();
        } catch (error) {
            console.error('认证检查失败:', error);
            // 如果检查失败，也尝试初始化（可能是首次使用）
            this.init();
        }
    }

    init() {
        // 初始化时间显示
        this.updateTime();
        setInterval(() => this.updateTime(), 1000);

        // 初始化导航
        this.initNavigation();

        // 加载初始数据
        this.loadDashboardData();
        this.fetchZones();
        this.fetchMonitors();
        this.loadSettings();

        // 启动监控轮询
        this.startMonitorPolling();

        // 绑定全局事件
        this.bindEvents();
    }

    async apiRequest(path, options = {}) {
        const url = `${this.baseURL}${path}`;
        const response = await fetch(url, options);

        let payload = null;
        try {
            payload = await response.json();
        } catch {
            // ignore
        }

        // 如果返回401未授权，跳转到登录页
        if (response.status === 401) {
            window.location.href = '/login.html';
            throw new Error('未登录或登录已过期');
        }

        if (!response.ok) {
            const message = payload?.msg || payload?.message || `请求失败: ${response.status}`;
            throw new Error(message);
        }

        if (payload && typeof payload === 'object' && 'code' in payload && 'data' in payload) {
            return payload.data;
        }
        return payload;
    }

    updateTime() {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('zh-CN');
        document.getElementById('current-time').textContent = timeStr;
        
        // 更新运行时间
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;
        document.getElementById('stat-uptime').textContent = 
            `${hours}h ${minutes}m ${seconds}s`;
    }

    initNavigation() {
        const sections = ['dashboard', 'domains', 'strategies', 'settings'];
        sections.forEach(section => {
            const navItem = document.getElementById(`nav-${section}`);
            if (navItem) {
                navItem.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.switchSection(section);
                });
            }
        });
    }

    switchSection(section) {
        // 更新导航状态
        ['dashboard', 'domains', 'strategies', 'settings'].forEach(s => {
            const navItem = document.getElementById(`nav-${s}`);
            const sectionEl = document.getElementById(`section-${s}`);
            
            if (navItem) {
                if (s === section) {
                    navItem.classList.add('active');
                } else {
                    navItem.classList.remove('active');
                }
            }
            
            if (sectionEl) {
                if (s === section) {
                    sectionEl.classList.remove('hidden');
                    sectionEl.classList.add('fade-in');
                } else {
                    sectionEl.classList.add('hidden');
                }
            }
        });

        // 更新标题
        const titles = {
            dashboard: '控制面板',
            domains: '域名管理',
            strategies: '监控策略',
            settings: '系统设置'
        };
        document.getElementById('section-title').textContent = titles[section] || '控制面板';

        // 加载特定数据
        switch(section) {
            case 'dashboard':
                this.loadDashboardData();
                break;
            case 'domains':
                this.updateAccountSwitcher();
                this.fetchZones();
                break;
            case 'strategies':
                this.fetchMonitors();
                break;
            case 'settings':
                this.loadSettings();
                break;
        }
    }

    async loadDashboardData() {
        try {
            const [monitors, status] = await Promise.all([
                this.apiRequest('/api/monitors'),
                this.apiRequest('/api/status')
            ]);

            let zones = [];
            try {
                zones = await this.apiRequest('/api/zones');
            } catch {
                zones = [];
            }
            
            // 更新统计数据
            const totalMonitors = Array.isArray(monitors) ? monitors.length : 0;
            const runtimeMonitors = status?.monitors || [];
            const healthyMonitors = runtimeMonitors.filter(m => m.status === 'Normal').length;
            const downMonitors = runtimeMonitors.filter(m => m.status === 'Down').length;
            
            document.getElementById('stat-total').textContent = totalMonitors;
            document.getElementById('stat-healthy').textContent = healthyMonitors;
            document.getElementById('stat-down').textContent = downMonitors;
            document.getElementById('stat-zones').textContent = Array.isArray(zones) ? zones.length : 0;
            
            // 更新系统状态
            if (status?.system) {
                const memAlloc = status.system.mem_alloc || 0;

                const gorEl = document.getElementById('stat-goroutines');
                if (gorEl) gorEl.textContent = status.system.goroutines || 0;

                const memEl = document.getElementById('stat-memory');
                if (memEl) memEl.textContent = `${Math.round(memAlloc / 1024 / 1024)} MB`;
            }
            
            // 更新监控列表
            this.updateMonitorList(monitors, runtimeMonitors);
            this.updateSystemLogs(status?.history || []);
            
            // 更新全局状态
            this.updateGlobalStatus(healthyMonitors, downMonitors);
            
        } catch (error) {
            console.error('加载仪表板数据失败:', error);
            this.showNotification('加载数据失败，请检查后端服务', 'error');
        }
    }

    updateMonitorList(monitors, runtimeMonitors) {
        const container = document.getElementById('dashboard-monitor-list');
        if (!container) return;

        const runtimeById = new Map((runtimeMonitors || []).map(m => [m.id, m]));
        
        if (!Array.isArray(monitors) || monitors.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8 text-gray-500">
                    <svg class="w-12 h-12 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                    </svg>
                    <p>暂无监控任务</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = monitors.slice(0, 5).map(monitor => {
            const runtime = runtimeById.get(monitor.id);
            const isDown = runtime?.status === 'Down';
            const statusClass = isDown ? 'status-error' : 'status-normal';
            const statusText = isDown ? '故障' : '正常';
            const target = monitor.check_target || monitor.original_ip || '';
            
            return `
                <div class="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200">
                    <div class="flex items-center gap-3">
                        <div class="w-3 h-3 rounded-full ${isDown ? 'bg-red-500' : 'bg-green-500'}"></div>
                        <div>
                            <h5 class="font-medium text-gray-800">${monitor.name || '(未命名)'}</h5>
                            <p class="text-xs text-gray-500">${target}</p>
                        </div>
                    </div>
                    <span class="status-badge ${statusClass}">${statusText}</span>
                </div>
            `;
        }).join('');
    }

    updateGlobalStatus(healthy, down) {
        const statusEl = document.getElementById('global-status');
        if (!statusEl) return;
        
        if (down > 0) {
            statusEl.className = 'status-badge status-error';
            statusEl.textContent = `${down}个故障`;
        } else if (healthy > 0) {
            statusEl.className = 'status-badge status-normal';
            statusEl.textContent = '系统运行正常';
        } else {
            statusEl.className = 'status-badge status-warning';
            statusEl.textContent = '无监控任务';
        }
    }

    updateSystemLogs(history) {
        const container = document.getElementById('system-logs');
        if (!container) return;

        if (!Array.isArray(history) || history.length === 0) {
            container.innerHTML = `
                <div class="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                    <div class="w-2 h-2 rounded-full bg-blue-500"></div>
                    <span class="text-sm text-gray-600">暂无切换事件</span>
                </div>
            `;
            return;
        }

        container.innerHTML = history.slice(0, 50).map(evt => {
            const timeStr = new Date(evt.timestamp).toLocaleString('zh-CN');
            const badge = evt.to_backup
                ? '<span class="text-xs px-2 py-1 rounded-full bg-orange-100 text-orange-800">切到备IP</span>'
                : '<span class="text-xs px-2 py-1 rounded-full bg-green-100 text-green-800">切回主IP</span>';

            return `
                <div class="p-3 bg-gray-50 rounded-lg space-y-1">
                    <div class="flex items-center justify-between gap-3">
                        <div class="text-sm font-medium text-gray-800">${evt.name || evt.monitor_id}</div>
                        ${badge}
                    </div>
                    <div class="text-xs text-gray-600">${evt.from_ip} → ${evt.to_ip}</div>
                    <div class="text-xs text-gray-500">${timeStr} · ${evt.check_type || ''}</div>
                </div>
            `;
        }).join('');
    }

    async fetchZones() {
        try {
            const zones = await this.apiRequest('/api/zones');
            this.renderZones(zones);
        } catch (error) {
            console.error('获取域名列表失败:', error);
            this.showNotification('获取域名列表失败', 'error');
        }
    }

    renderZones(zones) {
        const container = document.getElementById('zone-list');
        if (!container) return;
        
        if (!zones || zones.length === 0) {
            container.innerHTML = `
                <div class="col-span-full text-center py-12">
                    <svg class="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"></path>
                    </svg>
                    <h3 class="text-lg font-medium text-gray-700 mb-2">暂无域名</h3>
                    <p class="text-gray-500 mb-4">请先配置Cloudflare凭证</p>
                    <button onclick="dnsManager.switchSection('settings')" class="btn-primary">
                        前往设置
                    </button>
                </div>
            `;
            return;
        }
        
        container.innerHTML = zones.map(zone => `
            <div class="glass-card p-6 hover:shadow-xl transition-all duration-300 border-l-4 ${zone.status === 'active' ? 'border-green-500' : 'border-gray-300'}">
                <div class="flex items-start justify-between mb-4">
                    <div class="flex-1">
                        <div class="flex items-center gap-2 mb-2">
                            <div class="p-2 rounded-lg bg-gradient-to-br from-orange-50 to-orange-100">
                                <svg class="w-5 h-5 text-orange-600" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M12.5 2L2 7.5v9L12.5 22l10.5-5.5v-9L12.5 2zm0 2.311L20.689 8.5 12.5 12.689 4.311 8.5 12.5 4.311zM4 10.311l7.5 3.939v7.439L4 17.75v-7.439zm9.5 11.378v-7.439l7.5-3.939v7.439l-7.5 3.939z"/>
                                </svg>
                            </div>
                            <h3 class="font-bold text-gray-800 text-lg">${zone.name}</h3>
                        </div>
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="flex items-center gap-1 px-3 py-1 text-xs rounded-full ${zone.status === 'active' ? 'bg-green-100 text-green-800 border border-green-200' : 'bg-gray-100 text-gray-800 border border-gray-200'}">
                                <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
                                </svg>
                                ${zone.status === 'active' ? '已激活' : '未激活'}
                            </span>
                            <span class="px-3 py-1 text-xs rounded-full bg-blue-100 text-blue-800 border border-blue-200" title="Cloudflare Zone 类型：full=全量接入；partial=仅DNS">
                                ${zone.type === 'full' ? '🌐 全量接入' : '📡 仅DNS'}
                            </span>
                        </div>
                    </div>
                </div>
                
                <div class="space-y-3 mb-4">
                    <div class="p-3 bg-gradient-to-r from-gray-50 to-gray-100 rounded-lg">
                        <div class="text-xs text-gray-500 mb-1">Zone ID</div>
                        <div class="font-mono text-xs text-gray-700 break-all">${zone.id}</div>
                    </div>
                    <div class="flex items-center justify-between text-sm">
                        <span class="flex items-center gap-1 text-gray-500">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                            </svg>
                            创建时间
                        </span>
                        <span class="font-medium text-gray-700">${new Date(zone.created_on).toLocaleDateString('zh-CN')}</span>
                    </div>
                </div>
                
                <div class="mt-6">
                    <button onclick="dnsManager.viewRecords('${zone.id}', '${zone.name}')" 
                            class="w-full btn-primary flex items-center justify-center gap-2 py-3">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                        </svg>
                        管理DNS记录
                    </button>
                </div>
            </div>
        `).join('');
    }

    async viewRecords(zoneId, zoneName) {
        this.currentZoneId = zoneId;
        this.currentZoneName = zoneName;
        
        // 显示记录容器
        document.getElementById('zone-list').classList.add('hidden');
        document.getElementById('records-container').classList.remove('hidden');
        document.getElementById('current-zone-name').textContent = `${zoneName} - 解析记录`;
        
        // 加载记录
        await this.fetchRecords(zoneId);
    }

    hideRecords() {
        document.getElementById('zone-list').classList.remove('hidden');
        document.getElementById('records-container').classList.add('hidden');
        this.currentZoneId = null;
        this.currentZoneName = null;
    }

    async fetchRecords(zoneId) {
        try {
            const records = await this.apiRequest(`/api/zones/${zoneId}/records`);
            this.recordsCache = Array.isArray(records) ? records : [];
            this.renderRecords(records);
        } catch (error) {
            console.error('获取DNS记录失败:', error);
            this.showNotification('获取DNS记录失败', 'error');
        }
    }

    renderRecords(records) {
        const container = document.getElementById('records-list');
        if (!container) return;
        
        if (!records || records.length === 0) {
            container.innerHTML = `
                <tr>
                    <td colspan="6" class="py-8 text-center text-gray-500">
                        <svg class="w-12 h-12 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                        </svg>
                        <p>暂无DNS记录</p>
                    </td>
                </tr>
            `;
            return;
        }
        
        container.innerHTML = records.map(record => `
            <tr class="table-row">
                <td class="py-4 px-6">
                    <span class="px-3 py-1 text-xs rounded-full bg-blue-100 text-blue-800 font-medium">
                        ${record.type}
                    </span>
                </td>
                <td class="py-4 px-6 font-medium text-gray-800">${record.name}</td>
                <td class="py-4 px-6">
                    <div class="max-w-xs truncate" title="${record.content}">
                        ${record.content}
                    </div>
                </td>
                <td class="py-4 px-6">
                    <span class="px-3 py-1 text-xs rounded-full ${record.proxied ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}">
                        ${record.proxied ? '已代理' : '未代理'}
                    </span>
                </td>
                <td class="py-4 px-6 text-gray-600">${record.ttl}</td>
                <td class="py-4 px-6">
                    <div class="flex gap-2">
                        <button onclick="dnsManager.editRecord('${record.id}')" 
                                class="text-blue-600 hover:text-blue-800 text-sm font-medium">
                            编辑
                        </button>
                        <button onclick="dnsManager.deleteRecord('${record.id}')" 
                                class="text-red-600 hover:text-red-800 text-sm font-medium">
                            删除
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
    }

    async fetchMonitors() {
        try {
            const [monitors, status] = await Promise.all([
                this.apiRequest('/api/monitors'),
                this.apiRequest('/api/status')
            ]);
            const runtimeById = new Map((status?.monitors || []).map(m => [m.id, m]));
            const viewModels = (Array.isArray(monitors) ? monitors : []).map(m => ({
                ...m,
                runtime: runtimeById.get(m.id) || null
            }));
            this.monitorsCache = viewModels;
            this.renderMonitors(viewModels);
            this.renderOfflineHot(status?.offline_hot || []);
        } catch (error) {
            console.error('获取监控策略失败:', error);
            this.showNotification('获取监控策略失败', 'error');
        }
    }

    renderOfflineHot(items) {
        const container = document.getElementById('strategy-offline-hot');
        if (!container) return;

        if (!Array.isArray(items) || items.length === 0) {
            container.innerHTML = `
                <div class="p-4 bg-gray-50 rounded-lg border border-gray-200 text-sm text-gray-600">
                    暂无需要关注的策略
                </div>
            `;
            return;
        }

        container.innerHTML = items.slice(0, 10).map(it => {
            const name = it.name || it.monitor_id || '-';
            const ip = it.ip || '-';
            const role = it.role === 'backup' ? '备' : '主';
            const count = Number(it.count) || 0;
            const lastAt = it.last_at ? new Date(it.last_at).toLocaleString('zh-CN') : '';

            return `
                <div class="p-4 rounded-lg border border-red-200 bg-red-50 space-y-1">
                    <div class="flex items-center justify-between gap-3">
                        <div class="font-medium text-gray-800 truncate">${name}</div>
                        <span class="text-xs px-2 py-1 rounded-full bg-red-100 text-red-800">掉线 ${count} 次</span>
                    </div>
                    <div class="text-xs text-gray-700">${role}IP：<span class="font-mono">${ip}</span></div>
                    ${lastAt ? `<div class="text-xs text-gray-500">最近：${lastAt}</div>` : ''}
                </div>
            `;
        }).join('');
    }

    enhanceMonitorActionBar(container) {
        if (!container) return;

        const editButtons = container.querySelectorAll('button[onclick^="dnsManager.editMonitor("]');
        editButtons.forEach(editBtn => {
            const parent = editBtn.parentElement;
            if (!parent) return;

            const deleteBtn = parent.querySelector('button[onclick^="dnsManager.deleteMonitor("]');
            if (!deleteBtn) return;

            parent.className = 'flex items-center justify-between gap-3 flex-wrap';

            editBtn.classList.remove('flex-1');
            editBtn.classList.add('py-2', 'px-3', 'text-sm');

            const restoreBtn = parent.querySelector('button[onclick^="dnsManager.openRestoreModal("]');
            if (restoreBtn) {
                restoreBtn.classList.remove('flex-1');
                restoreBtn.classList.add('py-2', 'px-3', 'text-sm');
            }

            deleteBtn.classList.add('text-sm', 'px-3', 'py-2');

            const match = (editBtn.getAttribute('onclick') || '').match(/'([^']+)'/);
            const monitorId = match ? match[1] : null;
            if (!monitorId) return;

            if (!parent.querySelector('button[onclick^="dnsManager.openScheduleSwitchModal("]')) {
                const group = document.createElement('div');
                group.className = 'flex items-center gap-2';

                group.appendChild(editBtn);
                if (restoreBtn) group.appendChild(restoreBtn);

                const scheduleBtn = document.createElement('button');
                scheduleBtn.className = 'btn-secondary py-2 px-3 text-sm';
                scheduleBtn.textContent = '定时切换';
                scheduleBtn.setAttribute('onclick', `dnsManager.openScheduleSwitchModal('${monitorId}')`);
                group.insertBefore(scheduleBtn, restoreBtn || null);

                parent.insertBefore(group, deleteBtn);
            }
        });
    }

    renderMonitors(monitors) {
        const container = document.getElementById('strategy-list');
        if (!container) return;
        
        if (!Array.isArray(monitors) || monitors.length === 0) {
            container.innerHTML = `
                <div class="text-center py-12">
                    <svg class="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                    </svg>
                    <h3 class="text-lg font-medium text-gray-700 mb-2">暂无监控策略</h3>
                    <p class="text-gray-500 mb-4">创建您的第一个监控策略</p>
                    <button onclick="dnsManager.openMonitorModal()" class="btn-primary">
                        创建策略
                    </button>
                </div>
            `;
            return;
        }
        
        container.innerHTML = monitors.map(monitor => {
            const isDown = monitor.runtime?.status === 'Down';
            const statusClass = isDown ? 'status-error' : 'status-normal';
            const statusText = isDown ? '故障' : '正常';
            const statusIcon = isDown 
                ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>'
                : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';

            const checkType = monitor.check_type || 'ping';
            const checkTypeText = {
                'ping': 'Ping检测',
                'tcping': 'TCPing检测', // 新增字典映射
                'http': 'HTTP检测',
                'https': 'HTTPS检测'
            }[checkType] || checkType;

            const checkTarget = monitor.check_target || (checkType === 'ping' ? (monitor.original_ip || '') : '');
            const subdomains = Array.isArray(monitor.subdomains) ? monitor.subdomains.join(', ') : '';
            
            const scheduleInfo = monitor.schedule_enabled && monitor.schedule_hours > 0
                ? `<div class="flex items-center gap-2 text-xs text-blue-600">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                    </svg>
                    <span>定时切换：每${monitor.schedule_hours}小时</span>
                   </div>`
                : '';

            return `
                <div class="glass-card p-6 hover:shadow-xl transition-all duration-300">
                    <div class="flex items-start justify-between mb-5">
                        <div class="flex-1">
                            <div class="flex items-center gap-3 mb-2">
                                <h3 class="font-bold text-gray-800 text-lg">${monitor.name || '(未命名)'}</h3>
                                <span class="status-badge ${statusClass} flex items-center gap-1">
                                    ${statusIcon}
                                    ${statusText}
                                </span>
                            </div>
                            ${scheduleInfo}
                        </div>
                    </div>

                    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                        <div class="bg-gradient-to-br from-blue-50 to-blue-100 p-3 rounded-lg border border-blue-200">
                            <p class="text-xs text-blue-600 mb-1 font-medium">检测类型</p>
                            <p class="font-semibold text-gray-800 text-sm">${checkTypeText}</p>
                        </div>
                        <div class="bg-gradient-to-br from-purple-50 to-purple-100 p-3 rounded-lg border border-purple-200">
                            <p class="text-xs text-purple-600 mb-1 font-medium">检测间隔</p>
                            <p class="font-semibold text-gray-800 text-sm">${monitor.interval || 60}秒</p>
                        </div>
                        <div class="bg-gradient-to-br from-green-50 to-green-100 p-3 rounded-lg border border-green-200">
                            <p class="text-xs text-green-600 mb-1 font-medium">主 IP</p>
                            <p class="font-semibold text-gray-800 text-sm font-mono">${monitor.original_ip || 'N/A'}</p>
                        </div>
                        <div class="bg-gradient-to-br from-orange-50 to-orange-100 p-3 rounded-lg border border-orange-200">
                            <p class="text-xs text-orange-600 mb-1 font-medium">备 IP</p>
                            <p class="font-semibold text-gray-800 text-sm font-mono">${monitor.backup_ip || 'N/A'}</p>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                        <div class="bg-gray-50 p-3 rounded-lg border border-gray-200">
                            <p class="text-xs text-gray-600 mb-1 font-medium">检测目标</p>
                            <p class="font-medium text-gray-800 text-sm break-all">${checkTarget || 'N/A'}</p>
                        </div>
                        <div class="bg-gray-50 p-3 rounded-lg border border-gray-200">
                            <p class="text-xs text-gray-600 mb-1 font-medium">子域名</p>
                            <p class="font-medium text-gray-800 text-sm break-all">${subdomains || 'N/A'}</p>
                        </div>
                    </div>

                    <div class="flex items-center gap-2 pt-3 border-t border-gray-200">
                        <button onclick="dnsManager.editMonitor('${monitor.id}')" 
                                class="flex items-center gap-1 px-3 py-2 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                            </svg>
                            编辑
                        </button>
                        <button onclick="dnsManager.openScheduleSwitchModal('${monitor.id}')" 
                                class="flex items-center gap-1 px-3 py-2 text-sm font-medium text-purple-600 hover:text-purple-800 hover:bg-purple-50 rounded-lg transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            </svg>
                            定时
                        </button>
                        ${isDown ? `
                        <button onclick="dnsManager.openRestoreModal('${monitor.id}')" 
                                class="flex items-center gap-1 px-3 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                            </svg>
                            恢复
                        </button>
                        ` : ''}
                        <div class="flex-1"></div>
                        <button onclick="dnsManager.deleteMonitor('${monitor.id}')" 
                                class="flex items-center gap-1 px-3 py-2 text-sm font-medium text-red-600 hover:text-red-800 hover:bg-red-50 rounded-lg transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                            </svg>
                            删除
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        this.enhanceMonitorActionBar(container);
    }

    async loadSettings() {
        try {
            const config = await this.apiRequest('/api/config');
            
            if (config.cloudflare) {
                document.getElementById('set-cf-token').value = config.cloudflare.api_token || '';
            }
            
            if (config.dingtalk) {
                document.getElementById('set-ding-enabled').checked = config.dingtalk.enabled || false;
                document.getElementById('set-ding-token').value = config.dingtalk.access_token || '';
                document.getElementById('set-ding-secret').value = config.dingtalk.secret || '';
            }

            if (config.email) {
                document.getElementById('set-email-enabled').checked = config.email.enabled || false;
                document.getElementById('set-email-host').value = config.email.host || '';
                document.getElementById('set-email-port').value = config.email.port || '';
                document.getElementById('set-email-username').value = config.email.username || '';
                document.getElementById('set-email-password').value = config.email.password || '';
                document.getElementById('set-email-to').value = config.email.to || '';
            }

            if (config.telegram) {
                document.getElementById('set-tg-enabled').checked = config.telegram.enabled || false;
                document.getElementById('set-tg-bot-token').value = config.telegram.bot_token || '';
                document.getElementById('set-tg-chat-id').value = config.telegram.chat_id || '';
            }
            
            // 加载Cloudflare凭证列表
            await this.loadCloudflareAccounts();
            
        } catch (error) {
            console.error('加载设置失败:', error);
        }
    }

    async loadCloudflareAccounts() {
        try {
            const data = await this.apiRequest('/api/cloudflare-accounts');
            this.renderCloudflareAccounts(data.accounts || [], data.active_index || 0);
        } catch (error) {
            console.error('加载Cloudflare凭证失败:', error);
        }
    }

    renderCloudflareAccounts(accounts, activeIndex) {
        const container = document.getElementById('cf-accounts-list');
        if (!container) return;

        if (!Array.isArray(accounts) || accounts.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8 text-gray-500">
                    <p>暂无凭证，点击下方按钮添加</p>
                </div>
            `;
            return;
        }

        container.innerHTML = accounts.map((account, index) => {
            const isActive = index === activeIndex;
            return `
                <div class="p-4 rounded-lg border ${isActive ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}">
                    <div class="flex items-center justify-between mb-2">
                        <div class="flex items-center gap-2">
                            <h4 class="font-medium text-gray-800">${account.name || '(未命名)'}</h4>
                            ${isActive ? '<span class="px-2 py-1 text-xs rounded-full bg-blue-500 text-white">当前使用</span>' : ''}
                        </div>
                        <div class="flex gap-2">
                            ${!isActive ? `<button onclick="dnsManager.activateAccount('${account.id}')" class="text-sm text-blue-600 hover:text-blue-800">激活</button>` : ''}
                            <button onclick="dnsManager.editAccount('${account.id}')" class="text-sm text-gray-600 hover:text-gray-800">编辑</button>
                            <button onclick="dnsManager.deleteAccount('${account.id}')" class="text-sm text-red-600 hover:text-red-800">删除</button>
                        </div>
                    </div>
                    <div class="text-xs text-gray-500">
                        Token: ${account.api_token ? '••••••' : '(未设置)'}
                    </div>
                </div>
            `;
        }).join('');
    }

    openAccountModal(account = null) {
        const modal = document.getElementById('account-modal');
        if (!modal) return;

        this.editingAccountId = account ? account.id : null;
        document.getElementById('account-modal-title').textContent = account ? '编辑凭证' : '添加凭证';
        document.getElementById('account-name').value = account ? account.name : '';
        document.getElementById('account-token').value = account ? account.api_token : '';
        
        modal.classList.remove('hidden');
    }

    hideAccountModal() {
        const modal = document.getElementById('account-modal');
        if (modal) modal.classList.add('hidden');
        this.editingAccountId = null;
    }

    async submitAccountForm() {
        const name = document.getElementById('account-name').value.trim();
        const token = document.getElementById('account-token').value.trim();

        if (!name) throw new Error('请填写凭证名称');
        if (!token) throw new Error('请填写API Token');

        const payload = { name, api_token: token };

        if (this.editingAccountId) {
            await this.apiRequest(`/api/cloudflare-accounts/${this.editingAccountId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            await this.apiRequest('/api/cloudflare-accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        this.hideAccountModal();
        this.showNotification('保存成功', 'success');
        await this.loadCloudflareAccounts();
    }

    async editAccount(accountId) {
        try {
            const data = await this.apiRequest('/api/cloudflare-accounts');
            const account = (data.accounts || []).find(a => a.id === accountId);
            if (!account) {
                this.showNotification('未找到该凭证', 'error');
                return;
            }
            this.openAccountModal(account);
        } catch (error) {
            console.error('加载凭证失败:', error);
            this.showNotification('加载凭证失败', 'error');
        }
    }

    async deleteAccount(accountId) {
        if (!confirm('确定要删除这个凭证吗？')) return;
        try {
            await this.apiRequest(`/api/cloudflare-accounts/${accountId}`, { method: 'DELETE' });
            this.showNotification('删除成功', 'success');
            await this.loadCloudflareAccounts();
        } catch (error) {
            console.error('删除凭证失败:', error);
            this.showNotification('删除失败', 'error');
        }
    }

    async activateAccount(accountId) {
        try {
            await this.apiRequest(`/api/cloudflare-accounts/${accountId}/activate`, { method: 'POST' });
            this.showNotification('凭证已激活', 'success');
            await this.loadCloudflareAccounts();
            await this.fetchZones();
        } catch (error) {
            console.error('激活凭证失败:', error);
            this.showNotification('激活失败', 'error');
        }
    }

    async switchAccount(accountId) {
        if (!accountId) return;
        try {
            await this.apiRequest(`/api/cloudflare-accounts/${accountId}/activate`, { method: 'POST' });
            this.showNotification('凭证已切换', 'success');
            await this.updateAccountSwitcher();
            await this.fetchZones();
        } catch (error) {
            console.error('切换凭证失败:', error);
            this.showNotification('切换失败', 'error');
        }
    }

    async updateAccountSwitcher() {
        try {
            const data = await this.apiRequest('/api/cloudflare-accounts');
            const accounts = data.accounts || [];
            const activeIndex = data.active_index || 0;
            
            // 更新当前凭证显示
            const currentNameEl = document.getElementById('current-account-name');
            if (currentNameEl) {
                const currentName = accounts[activeIndex]?.name || '默认凭证';
                currentNameEl.textContent = currentName;
            }
            
            // 更新切换器选项
            const switcher = document.getElementById('account-switcher');
            if (switcher) {
                switcher.innerHTML = '<option value="">切换凭证...</option>' +
                    accounts.map((acc, idx) => 
                        `<option value="${acc.id}" ${idx === activeIndex ? 'disabled' : ''}>${acc.name}${idx === activeIndex ? ' (当前)' : ''}</option>`
                    ).join('');
            }
        } catch (error) {
            console.error('更新凭证切换器失败:', error);
        }
    }

    async saveSettings() {
        const config = {
            cloudflare: {
                api_token: document.getElementById('set-cf-token').value
            },
            dingtalk: {
                enabled: document.getElementById('set-ding-enabled').checked,
                access_token: document.getElementById('set-ding-token').value,
                secret: document.getElementById('set-ding-secret').value
            },
            email: {
                enabled: document.getElementById('set-email-enabled').checked,
                host: document.getElementById('set-email-host').value,
                port: Number(document.getElementById('set-email-port').value) || 0,
                username: document.getElementById('set-email-username').value,
                password: document.getElementById('set-email-password').value,
                to: document.getElementById('set-email-to').value
            },
            telegram: {
                enabled: document.getElementById('set-tg-enabled').checked,
                bot_token: document.getElementById('set-tg-bot-token').value,
                chat_id: document.getElementById('set-tg-chat-id').value
            }
        };
        
        try {
            const response = await fetch(`${this.baseURL}/api/config`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(config)
            });
            
            if (response.ok) {
                this.showNotification('设置保存成功', 'success');
            } else {
                let msg = `保存失败: ${response.status}`;
                try {
                    const payload = await response.json();
                    msg = payload?.msg || payload?.message || msg;
                } catch {
                    // ignore
                }
                this.showNotification(msg, 'error');
            }
        } catch (error) {
            console.error('保存设置失败:', error);
            this.showNotification(`保存失败: ${error.message || error}`, 'error');
        }
    }

    openRecordModal() {
        if (!this.currentZoneId) {
            this.showNotification('请先选择一个域名再添加记录', 'warning');
            return;
        }
        this.editingRecordId = null;
        this.showRecordModal({
            type: 'A',
            name: '',
            content: '',
            ttl: 60,
            proxied: false
        });
    }

    openMonitorModal() {
        this.editingMonitorId = null;
        this.showMonitorModal({
            name: '',
            zone_id: '',
            subdomains: [],
            check_type: 'ping',
            check_target: '',
            original_ip: '',
            backup_ip: '',
            failure_threshold: 3,
            success_threshold: 2,
            interval: 60,
            ping_count: 5,
            timeout_seconds: 2,
            original_ip_cdn_enabled: false,
            backup_ip_cdn_enabled: true
        });
    }

    editRecord(recordId) {
        const record = this.recordsCache.find(r => r.id === recordId);
        if (!record) {
            this.showNotification('未找到该记录', 'error');
            return;
        }
        this.editingRecordId = recordId;
        this.showRecordModal(record);
    }

    async deleteRecord(recordId) {
        if (!this.currentZoneId) {
            this.showNotification('请先选择一个域名', 'warning');
            return;
        }
        if (!confirm('确定要删除这条DNS记录吗？')) return;
        try {
            await this.apiRequest(`/api/zones/${this.currentZoneId}/records/${recordId}`, { method: 'DELETE' });
            this.showNotification('删除成功', 'success');
            await this.fetchRecords(this.currentZoneId);
        } catch (error) {
            console.error('删除记录失败:', error);
            this.showNotification(`删除失败: ${error.message || error}`, 'error');
        }
    }

    showRecordModal(record) {
        const modal = document.getElementById('record-modal');
        if (!modal) {
            this.showNotification('缺少记录弹窗HTML', 'error');
            return;
        }

        document.getElementById('record-modal-title').textContent =
            this.editingRecordId ? '编辑记录' : '添加记录';

        document.getElementById('record-type').value = record.type || 'A';
        document.getElementById('record-name').value = record.name || '';
        document.getElementById('record-content').value = record.content || '';
        document.getElementById('record-ttl').value = record.ttl && record.ttl > 1 ? record.ttl : 60;
        document.getElementById('record-proxied').checked = !!record.proxied;

        modal.classList.remove('hidden');
    }

    hideRecordModal() {
        const modal = document.getElementById('record-modal');
        if (modal) modal.classList.add('hidden');
    }

    async submitRecordForm() {
        if (!this.currentZoneId) throw new Error('请先选择一个域名');

        const ttl = Math.max(60, Number(document.getElementById('record-ttl').value) || 60);
        const payload = {
            type: document.getElementById('record-type').value,
            name: document.getElementById('record-name').value.trim(),
            content: document.getElementById('record-content').value.trim(),
            ttl,
            proxied: !!document.getElementById('record-proxied').checked
        };

        if (!payload.name) throw new Error('请填写记录名称');
        if (!payload.content) throw new Error('请填写记录内容');

        if (this.editingRecordId) {
            await this.apiRequest(`/api/zones/${this.currentZoneId}/records/${this.editingRecordId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            await this.apiRequest(`/api/zones/${this.currentZoneId}/records`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        this.hideRecordModal();
        this.showNotification('保存成功', 'success');
        await this.fetchRecords(this.currentZoneId);
    }

    editMonitor(monitorId) {
        const monitor = this.monitorsCache.find(m => m.id === monitorId);
        if (!monitor) {
            this.showNotification('未找到该策略', 'error');
            return;
        }
        this.editingMonitorId = monitorId;
        this.showMonitorModal(monitor);
    }

    async deleteMonitor(monitorId) {
        if (!confirm('确定要删除这个监控策略吗？')) return;
        try {
            await this.apiRequest(`/api/monitors/${monitorId}`, { method: 'DELETE' });
            this.showNotification('删除成功', 'success');
            await this.fetchMonitors();
            await this.loadDashboardData();
        } catch (error) {
            console.error('删除监控失败:', error);
            this.showNotification(`删除失败: ${error.message || error}`, 'error');
        }
    }

    openRestoreModal(monitorId) {
        const monitor = this.monitorsCache.find(m => m.id === monitorId);
        if (!monitor) {
            this.showNotification('未找到该策略', 'error');
            return;
        }

        const modal = document.getElementById('restore-modal');
        if (!modal) {
            this.showNotification('缺少恢复弹窗HTML', 'error');
            return;
        }

        this.restoreMonitorId = monitorId;
        document.getElementById('restore-monitor-name').textContent = monitor.name || monitorId;
        document.getElementById('restore-proxied').checked = !!monitor.original_ip_cdn_enabled;
        modal.classList.remove('hidden');
    }

    hideRestoreModal() {
        const modal = document.getElementById('restore-modal');
        if (modal) modal.classList.add('hidden');
        this.restoreMonitorId = null;
    }

    async confirmRestore() {
        if (!this.restoreMonitorId) throw new Error('未选择策略');
        const proxied = !!document.getElementById('restore-proxied').checked;

        await this.apiRequest(`/api/monitors/${this.restoreMonitorId}/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxied })
        });

        this.hideRestoreModal();
        this.showNotification('已发起恢复', 'success');
        await this.fetchMonitors();
        await this.loadDashboardData();
    }

    openScheduleSwitchModal(monitorId) {
        const monitor = this.monitorsCache.find(m => m.id === monitorId);
        if (!monitor) {
            this.showNotification('未找到该策略', 'error');
            return;
        }

        const modal = document.getElementById('schedule-modal');
        if (!modal) {
            this.showNotification('缺少定时切换弹窗HTML', 'error');
            return;
        }

        this.scheduleMonitorId = monitorId;
        document.getElementById('schedule-monitor-name').textContent = monitor.name || monitorId;
        document.getElementById('schedule-enabled').checked = !!monitor.schedule_enabled;
        document.getElementById('schedule-hours').value = monitor.schedule_hours ?? '';
        document.getElementById('schedule-ip').value = monitor.schedule_switch_ip || '';
        modal.classList.remove('hidden');
    }

    hideScheduleSwitchModal() {
        const modal = document.getElementById('schedule-modal');
        if (modal) modal.classList.add('hidden');
        this.scheduleMonitorId = null;
    }

    async saveScheduleSwitch() {
        if (!this.scheduleMonitorId) throw new Error('未选择策略');
        const monitor = this.monitorsCache.find(m => m.id === this.scheduleMonitorId);
        if (!monitor) throw new Error('未找到该策略');

        const enabled = !!document.getElementById('schedule-enabled').checked;
        const hours = Number(document.getElementById('schedule-hours').value) || 0;
        const ip = document.getElementById('schedule-ip').value.trim();

        const payload = { ...monitor };
        delete payload.runtime;
        payload.schedule_enabled = enabled;
        payload.schedule_hours = enabled ? hours : 0;
        payload.schedule_switch_ip = enabled ? ip : '';

        await this.apiRequest(`/api/monitors/${this.scheduleMonitorId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        this.hideScheduleSwitchModal();
        this.showNotification('定时切换已保存', 'success');
        await this.fetchMonitors();
        await this.loadDashboardData();
    }

    showMonitorModal(monitor) {
        const modal = document.getElementById('monitor-modal');
        if (!modal) {
            this.showNotification('缺少监控策略弹窗HTML', 'error');
            return;
        }

        document.getElementById('monitor-modal-title').textContent =
            this.editingMonitorId ? '编辑监控策略' : '创建监控策略';

        document.getElementById('monitor-name').value = monitor.name || '';
        document.getElementById('monitor-zone-id').value = monitor.zone_id || this.currentZoneId || '';
        document.getElementById('monitor-subdomains').value = Array.isArray(monitor.subdomains) ? monitor.subdomains.join('\n') : '';
        document.getElementById('monitor-check-type').value = monitor.check_type || 'ping';
        document.getElementById('monitor-check-target').value = monitor.check_target || '';
        document.getElementById('monitor-original-ip').value = monitor.original_ip || '';
        document.getElementById('monitor-backup-ip').value = monitor.backup_ip || '';

        document.getElementById('monitor-failure-threshold').value = monitor.failure_threshold ?? 3;
        document.getElementById('monitor-success-threshold').value = monitor.success_threshold ?? 2;
        document.getElementById('monitor-interval').value = monitor.interval ?? 60;
        document.getElementById('monitor-ping-count').value = monitor.ping_count ?? 5;
        document.getElementById('monitor-timeout-seconds').value = monitor.timeout_seconds ?? 2;
        document.getElementById('monitor-original-cdn').checked = !!monitor.original_ip_cdn_enabled;
        document.getElementById('monitor-backup-cdn').checked = !!monitor.backup_ip_cdn_enabled;

        modal.classList.remove('hidden');
    }

    hideMonitorModal() {
        const modal = document.getElementById('monitor-modal');
        if (modal) modal.classList.add('hidden');
    }

    normalizeSubdomains(text) {
        return (text || '')
            .split(/[\n,]/g)
            .map(s => s.trim())
            .filter(Boolean);
    }

    async submitMonitorForm() {
        const checkType = document.getElementById('monitor-check-type').value;
        let checkTarget = document.getElementById('monitor-check-target').value.trim();
        if ((checkType === 'http' || checkType === 'https') && checkTarget && !/^https?:\/\//i.test(checkTarget)) {
            checkTarget = `${checkType}://${checkTarget}`;
        }

        const payload = {
            name: document.getElementById('monitor-name').value.trim(),
            zone_id: document.getElementById('monitor-zone-id').value.trim(),
            subdomains: this.normalizeSubdomains(document.getElementById('monitor-subdomains').value),
            check_type: checkType,
            check_target: checkTarget,
            original_ip: document.getElementById('monitor-original-ip').value.trim(),
            backup_ip: document.getElementById('monitor-backup-ip').value.trim(),
            failure_threshold: Number(document.getElementById('monitor-failure-threshold').value) || 3,
            success_threshold: Number(document.getElementById('monitor-success-threshold').value) || 2,
            interval: Number(document.getElementById('monitor-interval').value) || 60,
            ping_count: Number(document.getElementById('monitor-ping-count').value) || 5,
            timeout_seconds: Number(document.getElementById('monitor-timeout-seconds').value) || 2,
            original_ip_cdn_enabled: !!document.getElementById('monitor-original-cdn').checked,
            backup_ip_cdn_enabled: !!document.getElementById('monitor-backup-cdn').checked
        };

        if (!payload.name) throw new Error('请填写策略名称');
        if (!payload.zone_id) throw new Error('请填写 Zone ID');
        if (!payload.original_ip) throw new Error('请填写主IP');
        if (!payload.backup_ip) throw new Error('请填写备IP');
        if (!payload.subdomains.length) throw new Error('请至少填写一个子域名');
        if ((payload.check_type === 'http' || payload.check_type === 'https') && !payload.check_target) {
            throw new Error('HTTP/HTTPS 检测需要填写检测目标(URL)');
        }

        if (this.editingMonitorId) {
            await this.apiRequest(`/api/monitors/${this.editingMonitorId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            await this.apiRequest('/api/monitors', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }

        this.hideMonitorModal();
        this.showNotification('保存成功', 'success');
        await this.fetchMonitors();
        await this.loadDashboardData();
    }

    startMonitorPolling() {
        // 每30秒更新一次监控状态
        this.monitorInterval = setInterval(() => {
            if (document.getElementById('section-dashboard') && 
                !document.getElementById('section-dashboard').classList.contains('hidden')) {
                this.loadDashboardData();
            }
        }, 30000);
    }

    bindEvents() {
        // 绑定设置保存按钮
        const saveBtn = document.getElementById('save-settings');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveSettings());
        }

        const monitorClose = document.getElementById('monitor-modal-close');
        if (monitorClose) monitorClose.addEventListener('click', () => this.hideMonitorModal());

        const monitorCancel = document.getElementById('monitor-modal-cancel');
        if (monitorCancel) monitorCancel.addEventListener('click', () => this.hideMonitorModal());

        const monitorForm = document.getElementById('monitor-form');
        if (monitorForm) {
            monitorForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                try {
                    await this.submitMonitorForm();
                } catch (error) {
                    console.error('保存监控策略失败:', error);
                    this.showNotification(error.message || '保存失败', 'error');
                }
            });
        }

        const recordClose = document.getElementById('record-modal-close');
        if (recordClose) recordClose.addEventListener('click', () => this.hideRecordModal());

        const recordCancel = document.getElementById('record-modal-cancel');
        if (recordCancel) recordCancel.addEventListener('click', () => this.hideRecordModal());

        const recordForm = document.getElementById('record-form');
        if (recordForm) {
            recordForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                try {
                    await this.submitRecordForm();
                } catch (error) {
                    console.error('保存记录失败:', error);
                    this.showNotification(error.message || '保存失败', 'error');
                }
            });
        }

        const restoreClose = document.getElementById('restore-modal-close');
        if (restoreClose) restoreClose.addEventListener('click', () => this.hideRestoreModal());

        const restoreCancel = document.getElementById('restore-modal-cancel');
        if (restoreCancel) restoreCancel.addEventListener('click', () => this.hideRestoreModal());

        const restoreConfirm = document.getElementById('restore-modal-confirm');
        if (restoreConfirm) {
            restoreConfirm.addEventListener('click', async () => {
                try {
                    await this.confirmRestore();
                } catch (error) {
                    console.error('恢复失败:', error);
                    this.showNotification(error.message || '恢复失败', 'error');
                }
            });
        }

        const scheduleClose = document.getElementById('schedule-modal-close');
        if (scheduleClose) scheduleClose.addEventListener('click', () => this.hideScheduleSwitchModal());

        const scheduleCancel = document.getElementById('schedule-modal-cancel');
        if (scheduleCancel) scheduleCancel.addEventListener('click', () => this.hideScheduleSwitchModal());

        const scheduleSave = document.getElementById('schedule-modal-save');
        if (scheduleSave) {
            scheduleSave.addEventListener('click', async () => {
                try {
                    await this.saveScheduleSwitch();
                } catch (error) {
                    console.error('保存定时切换失败:', error);
                    this.showNotification(error.message || '保存失败', 'error');
                }
            });
        }

        const accountClose = document.getElementById('account-modal-close');
        if (accountClose) accountClose.addEventListener('click', () => this.hideAccountModal());

        const accountCancel = document.getElementById('account-modal-cancel');
        if (accountCancel) accountCancel.addEventListener('click', () => this.hideAccountModal());

        const accountForm = document.getElementById('account-form');
        if (accountForm) {
            accountForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                try {
                    await this.submitAccountForm();
                } catch (error) {
                    console.error('保存凭证失败:', error);
                    this.showNotification(error.message || '保存失败', 'error');
                }
            });
        }
    }

    showNotification(message, type = 'info') {
        // 创建通知元素
        const notification = document.createElement('div');
        notification.className = `fixed top-4 right-4 z-50 px-6 py-4 rounded-lg shadow-lg transform transition-all duration-300 ${
            type === 'success' ? 'bg-green-500 text-white' :
            type === 'error' ? 'bg-red-500 text-white' :
            type === 'warning' ? 'bg-yellow-500 text-white' :
            'bg-blue-500 text-white'
        }`;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        // 3秒后移除
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, 3000);
    }
}

// 全局实例
let dnsManager;

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    dnsManager = new DNSManager();
    
    // 暴露全局函数供HTML调用
    window.switchSection = (section) => dnsManager.switchSection(section);
    window.fetchZones = () => dnsManager.fetchZones();
    window.hideRecords = () => dnsManager.hideRecords();
    window.openRecordModal = () => dnsManager.openRecordModal();
    window.openMonitorModal = () => dnsManager.openMonitorModal();
    window.openAccountModal = () => dnsManager.openAccountModal();
    window.saveSettings = () => dnsManager.saveSettings();
    window.switchAccount = (accountId) => dnsManager.switchAccount(accountId);
});
