package monitor

import (
	"context"
	"log"
	"net"       // 新增：用于 TCP 连接
	"net/http"
	"strings"   // 新增：用于字符串处理
	"sync"
	"time"

	"dns-failover/internal/config"

	probing "github.com/prometheus-community/pro-bing"
)

type Status string

const (
	StatusNormal Status = "Normal"
	StatusDown   Status = "Down"
)

type Monitor struct {
	Config    config.MonitorConfig
	Status    Status
	CurrentIP string
	FailCount int
	SuccCount int

	BackupFailCount int
	BackupDown      bool
	mu        sync.RWMutex
}

type Engine struct {
	Monitors map[string]*Monitor
	OnSwitch func(m *Monitor, toBackup bool)
	// OnScheduledSwitch is called when a monitor performs a scheduled switch (not a failover).
	// It receives the from/to IP so the caller can update DNS and write history.
	OnScheduledSwitch func(m *Monitor, fromIP, toIP string)
	// OnIPDown is called when original/backup IP is considered down (transition event).
	OnIPDown func(m *Monitor, ip, role string)
	mu       sync.RWMutex
	cancels  map[string]context.CancelFunc
}

func NewEngine() *Engine {
	return &Engine{
		Monitors: make(map[string]*Monitor),
		cancels:  make(map[string]context.CancelFunc),
	}
}

func (e *Engine) StartMonitor(ctx context.Context, cfg config.MonitorConfig) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if cancel, ok := e.cancels[cfg.ID]; ok {
		cancel()
	}

	mCtx, cancel := context.WithCancel(ctx)
	e.cancels[cfg.ID] = cancel

	m := &Monitor{
		Config:    cfg,
		Status:    StatusNormal,
		CurrentIP: cfg.OriginalIP,
	}
	e.Monitors[cfg.ID] = m

	go e.run(mCtx, m)
	if cfg.ScheduleEnabled && cfg.ScheduleHours > 0 {
		go e.runSchedule(mCtx, m)
	}
}

func (e *Engine) StopMonitor(id string) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if cancel, ok := e.cancels[id]; ok {
		cancel()
		delete(e.cancels, id)
		delete(e.Monitors, id)
	}
}

func (e *Engine) ForceRestore(id string) (fromIP string, ok bool) {
	e.mu.RLock()
	m := e.Monitors[id]
	e.mu.RUnlock()
	if m == nil {
		return "", false
	}

	m.mu.Lock()
	fromIP = m.CurrentIP
	m.Status = StatusNormal
	m.CurrentIP = m.Config.OriginalIP
	m.FailCount = 0
	m.SuccCount = 0
	m.mu.Unlock()

	return fromIP, true
}

func (e *Engine) run(ctx context.Context, m *Monitor) {
	interval := m.Config.Interval
	if interval <= 0 {
		interval = 60
	}
	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.check(m)
		}
	}
}

func (e *Engine) runSchedule(ctx context.Context, m *Monitor) {
	hours := m.Config.ScheduleHours
	if hours <= 0 {
		return
	}
	ticker := time.NewTicker(time.Duration(hours) * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.scheduledSwitch(m)
		}
	}
}

func (e *Engine) scheduledSwitch(m *Monitor) {
	m.mu.Lock()
	// Avoid interfering while failover is active.
	if m.Status == StatusDown {
		m.mu.Unlock()
		return
	}

	fromIP := m.CurrentIP
	toIP := ""
	if m.Config.ScheduleSwitchIP != "" {
		toIP = m.Config.ScheduleSwitchIP
	} else if fromIP == m.Config.OriginalIP {
		toIP = m.Config.BackupIP
	} else {
		toIP = m.Config.OriginalIP
	}

	if toIP == "" || toIP == fromIP {
		m.mu.Unlock()
		return
	}

	m.CurrentIP = toIP
	m.FailCount = 0
	m.SuccCount = 0
	m.mu.Unlock()

	if e.OnScheduledSwitch != nil {
		go e.OnScheduledSwitch(m, fromIP, toIP)
	}
}

func (e *Engine) check(m *Monitor) {
	var success bool
	switch m.Config.CheckType {
	case "http", "https":
		success = e.checkHTTP(m)
	case "tcping":               // 新增：TCPing 分支
		success = e.checkTCP(m)
	default: // ping
		success = e.checkPing(m)
	}

	if success {
		e.handleSuccess(m)
	} else {
		e.handleFailure(m)
	}

	// When failover is active, also watch the backup IP health (ping only) so we can surface alerts.
	e.checkBackupHealth(m)
}

func (e *Engine) checkBackupHealth(m *Monitor) {
	m.mu.RLock()
	shouldCheck := m.Status == StatusDown && m.Config.CheckType == "ping" && m.Config.BackupIP != ""
	backupIP := m.Config.BackupIP
	pingCount := m.Config.PingCount
	timeoutSeconds := m.Config.TimeoutSeconds
	failureThreshold := m.Config.FailureThreshold
	wasDown := m.BackupDown
	failCount := m.BackupFailCount
	m.mu.RUnlock()

	if !shouldCheck {
		return
	}
	if pingCount <= 0 {
		pingCount = 5
	}
	if timeoutSeconds <= 0 {
		timeoutSeconds = 2
	}
	if failureThreshold <= 0 {
		failureThreshold = 3
	}

	pinger, err := probing.NewPinger(backupIP)
	if err != nil {
		return
	}
	pinger.Count = pingCount
	pinger.Timeout = time.Second * time.Duration(timeoutSeconds)
	pinger.SetPrivileged(false)

	if err := pinger.Run(); err != nil {
		// Treat as failure.
	} else {
		stats := pinger.Statistics()
		if stats.PacketLoss < 60.0 {
			// Success: reset.
			m.mu.Lock()
			m.BackupFailCount = 0
			m.BackupDown = false
			m.mu.Unlock()
			return
		}
	}

	failCount++
	trigger := failCount >= failureThreshold && !wasDown

	m.mu.Lock()
	if trigger {
		m.BackupDown = true
		m.BackupFailCount = 0
	} else {
		m.BackupFailCount = failCount
	}
	m.mu.Unlock()

	if trigger && e.OnIPDown != nil {
		go e.OnIPDown(m, backupIP, "backup")
	}
}

func (e *Engine) checkPing(m *Monitor) bool {
	target := m.Config.CheckTarget
	if target == "" {
		target = m.Config.OriginalIP
	}
	pinger, err := probing.NewPinger(target)
	if err != nil {
		log.Printf("Failed to create pinger for %s: %v", m.Config.Name, err)
		return false
	}

	pinger.Count = m.Config.PingCount
	if pinger.Count <= 0 {
		pinger.Count = 5
	}
	timeoutSeconds := m.Config.TimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = 2
	}
	pinger.Timeout = time.Second * time.Duration(timeoutSeconds)
	pinger.SetPrivileged(false)

	err = pinger.Run()
	if err != nil {
		log.Printf("Ping error for %s: %v", m.Config.Name, err)
		return false
	}

	stats := pinger.Statistics()
	return stats.PacketLoss < 60.0
}

func (e *Engine) checkHTTP(m *Monitor) bool {
	target := m.Config.CheckTarget
	if target == "" {
		return false
	}

	timeoutSeconds := m.Config.TimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = 10
	}
	client := &http.Client{
		Timeout: time.Second * time.Duration(timeoutSeconds),
	}

	resp, err := client.Get(target)
	if err != nil {
		log.Printf("HTTP check error for %s: %v", m.Config.Name, err)
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode >= 200 && resp.StatusCode < 400
}


func (e *Engine) checkTCP(m *Monitor) bool {
	target := m.Config.CheckTarget
	// 如果用户没有填写检测目标，默认使用主IP
	if target == "" {
		target = m.Config.OriginalIP
	}

	// TCP 检测必须有端口，如果用户没有带冒号，默认追加 :80 端口
	if !strings.Contains(target, ":") {
		target = target + ":80"
	}

	timeoutSeconds := m.Config.TimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = 2
	}

	// 尝试建立 TCP 连接
	conn, err := net.DialTimeout("tcp", target, time.Second*time.Duration(timeoutSeconds))
	if err != nil {
		log.Printf("TCP check error for %s (%s): %v", m.Config.Name, target, err)
		return false
	}
	defer conn.Close()
	return true
}

func (e *Engine) handleFailure(m *Monitor) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.Status == StatusNormal {
		m.FailCount++
		log.Printf("Monitor %s: failure count %d/%d", m.Config.Name, m.FailCount, m.Config.FailureThreshold)
		if m.FailCount >= m.Config.FailureThreshold {
			if e.OnIPDown != nil {
				go e.OnIPDown(m, m.Config.OriginalIP, "original")
			}
			m.Status = StatusDown
			m.CurrentIP = m.Config.BackupIP
			m.FailCount = 0
			if e.OnSwitch != nil {
				go e.OnSwitch(m, true)
			}
		}
	} else {
		m.SuccCount = 0
	}
}

func (e *Engine) handleSuccess(m *Monitor) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.Status == StatusDown {
		m.SuccCount++
		log.Printf("Monitor %s: success count %d/%d", m.Config.Name, m.SuccCount, m.Config.SuccessThreshold)
		if m.SuccCount >= m.Config.SuccessThreshold {
			m.Status = StatusNormal
			m.CurrentIP = m.Config.OriginalIP
			m.SuccCount = 0
			if e.OnSwitch != nil {
				go e.OnSwitch(m, false)
			}
		}
	} else {
		m.FailCount = 0
	}
}

func (e *Engine) GetStatus() []map[string]interface{} {
	e.mu.RLock()
	defer e.mu.RUnlock()

	res := make([]map[string]interface{}, 0)
	for _, m := range e.Monitors {
		m.mu.RLock()
		res = append(res, map[string]interface{}{
			"id":         m.Config.ID,
			"name":       m.Config.Name,
			"status":     m.Status,
			"current_ip": m.CurrentIP,
			"fail_count": m.FailCount,
			"succ_count": m.SuccCount,
			"check_type": m.Config.CheckType,
		})
		m.mu.RUnlock()
	}
	return res
}
