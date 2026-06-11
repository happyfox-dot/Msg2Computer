/**
 * TOTP 持久化存储模块
 * 使用 JSON 文件 + crypto 加密
 * 支持跨重启数据持久化
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

class TotpStorage {
    constructor() {
        this.isReady = false;
        this.dataDir = null;
        this.dataFile = null;
        this.keyFile = null;
        this.encryptionKey = null;
        this.data = null;
        console.log('[TotpStorage] Constructor called');
    }

    /**
     * 初始化存储
     */
    initialize() {
        if (this.isReady) return;

        try {
            // 确定数据目录
            const appDataDir = process.env.APPDATA ||
                              path.join(os.homedir(), 'AppData', 'Roaming');
            this.dataDir = path.join(appDataDir, 'codebridge');
            this.dataFile = path.join(this.dataDir, 'totp-store.json');
            this.keyFile = path.join(os.homedir(), '.codebridge-key');

            // 创建目录
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
            }

            // 加载或生成加密密钥
            this.encryptionKey = this.loadOrCreateKey();

            // 加载数据
            this.loadData();

            this.isReady = true;
            console.log('[TotpStorage] Initialized successfully');
            console.log('[TotpStorage] Data file:', this.dataFile);
        } catch (error) {
            console.error('[TotpStorage] Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * 加载或创建加密密钥。
     *
     * 密钥本身用 Electron safeStorage（Windows 上即 DPAPI）加密后落盘，文件加
     * `safe:` 前缀；这样即使 home 目录被其它进程读到，拿到的也是受 OS 用户态密钥
     * 保护的密文。safeStorage 不可用（无 Electron / 个别 Linux 桌面）时退回明文存储，
     * 但仍是每机随机密钥——绝不回退到全局已知常量（旧实现的 sha256('codebridge-default-key')
     * 对所有安装都相同，等于未加密）。
     *
     * 兼容旧版:旧的明文 hex 密钥文件继续可读，读到后若 safeStorage 可用则就地重写为密文。
     */
    loadOrCreateKey() {
        const safeStorage = this.getSafeStorage();

        try {
            if (fs.existsSync(this.keyFile)) {
                const raw = fs.readFileSync(this.keyFile, 'utf8').trim();
                if (raw.startsWith('safe:')) {
                    if (!safeStorage) {
                        throw new Error('密钥文件为 DPAPI 密文，但当前环境 safeStorage 不可用');
                    }
                    return safeStorage.decryptString(Buffer.from(raw.slice(5), 'base64'));
                }
                // 旧版明文 hex 密钥：仍可读；若现在能用 safeStorage 就升级为密文落盘
                if (raw) {
                    if (safeStorage) this.persistKey(raw, safeStorage);
                    return raw;
                }
            }

            const key = crypto.randomBytes(32).toString('hex');
            this.persistKey(key, safeStorage);
            console.log('[TotpStorage] Generated new encryption key');
            return key;
        } catch (error) {
            // 读/写密钥失败：用一次性随机密钥兜底（本次会话内可用），不落地、不复用全局常量。
            // 这会导致已有密文本次无法解密（loadData 会回退默认数据），但不引入“所有安装同一把密钥”的漏洞。
            console.error('[TotpStorage] 密钥读写失败，使用一次性随机会话密钥:', error.message);
            return crypto.randomBytes(32).toString('hex');
        }
    }

    /** 拿到 Electron safeStorage（仅在 Electron 主进程可用且已就绪时返回，否则 null）。 */
    getSafeStorage() {
        try {
            const electron = require('electron');
            const safeStorage = electron && electron.safeStorage;
            if (safeStorage && safeStorage.isEncryptionAvailable()) return safeStorage;
        } catch (_) {
            // 非 Electron 环境（如测试脚本）：require 失败，退回明文
        }
        return null;
    }

    /** 落盘密钥:safeStorage 可用则写 DPAPI 密文（safe: 前缀），否则写明文。 */
    persistKey(keyHex, safeStorage) {
        const out = safeStorage
            ? `safe:${safeStorage.encryptString(keyHex).toString('base64')}`
            : keyHex;
        fs.writeFileSync(this.keyFile, out, 'utf8');
        // 尽力收紧文件权限（POSIX 上 0600；Windows 上 chmod 基本是 no-op，靠 DPAPI 保护）
        try { fs.chmodSync(this.keyFile, 0o600); } catch (_) {}
    }

    /**
     * 加密数据
     */
    encrypt(text) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(this.encryptionKey, 'hex'), iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return `gcm:${iv.toString('hex')}:${authTag}:${encrypted}`;
    }

    /**
     * 解密数据
     */
    decrypt(text) {
        if (text.startsWith('gcm:')) {
            const parts = text.split(':');
            const iv = Buffer.from(parts[1], 'hex');
            const authTag = Buffer.from(parts[2], 'hex');
            const encrypted = parts[3];
            const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(this.encryptionKey, 'hex'), iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }

        // Legacy AES-CBC data written by versions before authenticated storage.
        const parts = text.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = parts[1];
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(this.encryptionKey, 'hex'), iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    /**
     * 加载数据
     */
    loadData() {
        try {
            if (fs.existsSync(this.dataFile)) {
                const encrypted = fs.readFileSync(this.dataFile, 'utf8');
                const decrypted = this.decrypt(encrypted);
                this.data = JSON.parse(decrypted);
                console.log('[TotpStorage] Loaded data:', {
                    totps: this.data.totps?.length || 0,
                    sms: this.data.smsVerifications?.length || 0
                });
            } else {
                this.data = this.getDefaultData();
                this.saveData();
            }
        } catch (error) {
            console.error('[TotpStorage] Failed to load data, using defaults:', error);
            this.data = this.getDefaultData();
        }
    }

    /**
     * 保存数据
     */
    saveData() {
        try {
            const json = JSON.stringify(this.data, null, 2);
            const encrypted = this.encrypt(json);
            fs.writeFileSync(this.dataFile, encrypted, 'utf8');
        } catch (error) {
            console.error('[TotpStorage] Failed to save data:', error);
        }
    }

    /**
     * 获取默认数据结构
     */
    getDefaultData() {
        return {
            totps: [],
            smsVerifications: [],
            lastSync: 0,
            deviceInfo: {}
        };
    }

    /**
     * 确保已初始化
     */
    ensureInitialized() {
        if (!this.isReady) {
            throw new Error('TotpStorage not initialized');
        }
    }

    /**
     * 生成唯一 ID
     */
    generateId() {
        return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    }

    normalizeTotpSecret(secret) {
        return String(secret || '').toUpperCase().replace(/[\s-]/g, '');
    }

    normalizeComparableText(value) {
        return String(value || '').trim().toLowerCase();
    }

    isSameTotpConfig(a, b) {
        if (!a || !b) return false;
        if (this.normalizeTotpSecret(a.secret) !== this.normalizeTotpSecret(b.secret)) return false;
        if (String(a.algorithm || 'SHA1').toUpperCase() !== String(b.algorithm || 'SHA1').toUpperCase()) return false;
        if (Number(a.digits || 6) !== Number(b.digits || 6)) return false;
        if (Number(a.period || 30) !== Number(b.period || 30)) return false;

        const issuerA = this.normalizeComparableText(a.issuer);
        const issuerB = this.normalizeComparableText(b.issuer);
        const accountA = this.normalizeComparableText(a.accountName);
        const accountB = this.normalizeComparableText(b.accountName);
        const labelA = this.normalizeComparableText(a.label);
        const labelB = this.normalizeComparableText(b.label);

        if (issuerA && issuerB && issuerA === issuerB && (!accountA || !accountB || accountA === accountB)) return true;
        if (accountA && accountB && accountA === accountB && (!issuerA || !issuerB || issuerA === issuerB)) return true;
        return !!labelA && labelA === labelB;
    }

    // ==================== TOTP 管理 ====================

    getAllTotps() {
        this.ensureInitialized();
        return this.data.totps || [];
    }

    addTotp(totp) {
        this.ensureInitialized();
        const newTotp = {
            id: totp.id || this.generateId(),
            label: totp.label,
            secret: totp.secret,
            issuer: totp.issuer || '',
            accountName: totp.accountName || '',
            algorithm: totp.algorithm || 'SHA1',
            digits: totp.digits || 6,
            period: totp.period || 30,
            sourceDeviceId: totp.sourceDeviceId || this.getDeviceId(),
            sourceDeviceName: totp.sourceDeviceName || this.getDeviceName(),
            sourceDeviceType: totp.sourceDeviceType || 'WINDOWS_DESKTOP',
            isLocal: totp.isLocal !== undefined ? totp.isLocal : true,
            canEdit: totp.canEdit !== undefined ? totp.canEdit : true,
            canDelete: totp.canDelete !== undefined ? totp.canDelete : true,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        const existingIndex = this.data.totps.findIndex(item => this.isSameTotpConfig(item, newTotp));
        if (existingIndex >= 0) {
            this.data.totps[existingIndex] = {
                ...this.data.totps[existingIndex],
                ...newTotp,
                id: this.data.totps[existingIndex].id,
                createdAt: this.data.totps[existingIndex].createdAt,
                updatedAt: Date.now(),
                importAction: 'updated'
            };
            this.saveData();
            console.log('[TotpStorage] Updated duplicate TOTP:', newTotp.label);
            return this.data.totps[existingIndex];
        }

        newTotp.importAction = 'added';
        this.data.totps.push(newTotp);
        this.saveData();
        console.log('[TotpStorage] Added TOTP:', newTotp.label);
        return newTotp;
    }

    updateTotp(id, updates) {
        this.ensureInitialized();
        const index = this.data.totps.findIndex(t => t.id === id);

        if (index !== -1) {
            const allowedFields = ['label', 'issuer', 'accountName', 'algorithm', 'digits', 'period'];
            const filtered = {};
            allowedFields.forEach(field => {
                if (updates[field] !== undefined) {
                    filtered[field] = updates[field];
                }
            });

            this.data.totps[index] = {
                ...this.data.totps[index],
                ...filtered,
                updatedAt: Date.now()
            };

            this.saveData();
            console.log('[TotpStorage] Updated TOTP:', id);
            return this.data.totps[index];
        }

        return null;
    }

    deleteTotp(id) {
        this.ensureInitialized();
        const before = this.data.totps.length;
        this.data.totps = this.data.totps.filter(t => t.id !== id);

        if (this.data.totps.length < before) {
            this.saveData();
            console.log('[TotpStorage] Deleted TOTP:', id);
            return true;
        }

        return false;
    }

    getTotpById(id) {
        this.ensureInitialized();
        return this.data.totps.find(t => t.id === id);
    }

    // ==================== 短信验证码管理 ====================

    getAllSms() {
        this.ensureInitialized();
        return this.data.smsVerifications || [];
    }

    addSms(sms) {
        this.ensureInitialized();
        const newSms = {
            id: sms.id || this.generateId(),
            content: sms.content,
            sender: sms.sender,
            sourceDeviceId: sms.sourceDeviceId,
            sourceDeviceName: sms.sourceDeviceName,
            sourceDeviceType: sms.sourceDeviceType,
            isLocal: sms.isLocal !== undefined ? sms.isLocal : false,
            canDelete: sms.canDelete !== undefined ? sms.canDelete : false,
            timestamp: sms.timestamp || Date.now()
        };

        this.data.smsVerifications.unshift(newSms);
        this.data.smsVerifications = this.data.smsVerifications.slice(0, 100);
        this.saveData();

        console.log('[TotpStorage] Added SMS from:', newSms.sourceDeviceName);
        return newSms;
    }

    deleteSms(id) {
        this.ensureInitialized();
        const before = this.data.smsVerifications.length;
        this.data.smsVerifications = this.data.smsVerifications.filter(s => s.id !== id);

        if (this.data.smsVerifications.length < before) {
            this.saveData();
            console.log('[TotpStorage] Deleted SMS:', id);
            return true;
        }

        return false;
    }

    clearAllSms() {
        this.ensureInitialized();
        this.data.smsVerifications = [];
        this.saveData();
        console.log('[TotpStorage] Cleared all SMS');
    }

    // ==================== 设备信息管理 ====================

    getDeviceId() {
        this.ensureInitialized();
        if (!this.data.deviceInfo.id) {
            this.data.deviceInfo.id = `desktop-${crypto.randomBytes(8).toString('hex')}`;
            this.saveData();
        }
        return this.data.deviceInfo.id;
    }

    getDeviceName() {
        this.ensureInitialized();
        if (!this.data.deviceInfo.name) {
            this.data.deviceInfo.name = os.hostname() || 'Desktop PC';
            this.saveData();
        }
        return this.data.deviceInfo.name;
    }

    setDeviceName(name) {
        this.ensureInitialized();
        this.data.deviceInfo.name = name;
        this.saveData();
    }

    // ==================== 统计信息 ====================

    getStats() {
        this.ensureInitialized();
        const totps = this.data.totps || [];
        const sms = this.data.smsVerifications || [];

        return {
            totpCount: totps.length,
            smsCount: sms.length,
            localTotpCount: totps.filter(t => t.isLocal).length,
            remoteTotpCount: totps.filter(t => !t.isLocal).length,
            lastSync: this.data.lastSync || 0
        };
    }

    // ==================== 数据导入导出 ====================

    exportData() {
        this.ensureInitialized();
        return {
            totps: this.data.totps,
            sms: this.data.smsVerifications,
            deviceInfo: this.data.deviceInfo,
            exportedAt: Date.now()
        };
    }

    importData(data) {
        this.ensureInitialized();
        if (data.totps) {
            this.data.totps = data.totps;
        }
        if (data.sms) {
            this.data.smsVerifications = data.sms;
        }
        this.saveData();
        console.log('[TotpStorage] Imported data');
    }

    clearAll() {
        this.ensureInitialized();
        this.data = this.getDefaultData();
        this.saveData();
        console.log('[TotpStorage] Cleared all data');
    }
}

module.exports = new TotpStorage();
