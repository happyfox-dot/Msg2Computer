/**
 * 二维码解析模块
 * 支持剪贴板监听、文件上传、拖拽上传
 */

const fs = require('fs');
const { clipboard, nativeImage } = require('electron');
const jsQR = require('jsqr');
const { createCanvas, loadImage } = require('canvas');

// ==================== Protobuf / Base32 工具 ====================
// 用于解析 Google Authenticator 批量迁移（otpauth-migration://）二维码。
// 迁移数据是一个 MigrationPayload protobuf 消息，结构见：
// https://github.com/google/google-authenticator-android 的 MigrationPayload。

/** 从 buffer 的 offset 处读取一个 varint，返回 { value, next }。 */
function readVarint(buffer, offset) {
    let result = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < buffer.length) {
        const b = buffer[pos];
        pos += 1;
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) {
            return { value: result, next: pos };
        }
        shift += 7n;
        if (shift > 70n) {
            throw new Error('Varint too long');
        }
    }
    throw new Error('Unexpected end of buffer while reading varint');
}

/** 跳过一个未知字段，返回新的 offset。 */
function skipField(buffer, offset, wireType) {
    switch (wireType) {
        case 0: { // varint
            return readVarint(buffer, offset).next;
        }
        case 1: // 64-bit
            return offset + 8;
        case 2: { // length-delimited
            const { value, next } = readVarint(buffer, offset);
            return next + Number(value);
        }
        case 5: // 32-bit
            return offset + 4;
        default:
            throw new Error(`Unknown wire type: ${wireType}`);
    }
}

/** 读取一段 length-delimited 字节，返回 { bytes, next }。 */
function readLengthDelimited(buffer, offset) {
    const { value, next } = readVarint(buffer, offset);
    const len = Number(value);
    const bytes = buffer.subarray(next, next + len);
    return { bytes, next: next + len };
}

/** 标准 RFC 4648 Base32 编码（无填充），用于把 protobuf 里的原始 secret 转回 otpauth secret。 */
function base32Encode(data) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let result = '';
    let buffer = 0;
    let bitsLeft = 0;
    for (const byte of data) {
        buffer = (buffer << 8) | byte;
        bitsLeft += 8;
        while (bitsLeft >= 5) {
            bitsLeft -= 5;
            result += alphabet[(buffer >> bitsLeft) & 0x1f];
        }
    }
    if (bitsLeft > 0) {
        result += alphabet[(buffer << (5 - bitsLeft)) & 0x1f];
    }
    return result;
}

const MIGRATION_ALGORITHMS = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
const MIGRATION_DIGITS = { 0: 6, 1: 6, 2: 8 };
// OtpType: 0=UNSPECIFIED, 1=HOTP, 2=TOTP
const OTP_TYPE_TOTP = 2;

/** 解析单个 OtpParameters 子消息，返回标准化的 TOTP 对象（非 TOTP 返回 null）。 */
function parseOtpParameters(data) {
    let offset = 0;
    let secret = null;
    let name = '';
    let issuer = '';
    let algorithm = 'SHA1';
    let digits = 6;
    let type = OTP_TYPE_TOTP;

    while (offset < data.length) {
        const { value: tag, next } = readVarint(data, offset);
        offset = next;
        const fieldNumber = Number(tag >> 3n);
        const wireType = Number(tag & 0x7n);

        switch (fieldNumber) {
            case 1: { // secret (bytes)
                const r = readLengthDelimited(data, offset);
                secret = r.bytes;
                offset = r.next;
                break;
            }
            case 2: { // name (string)
                const r = readLengthDelimited(data, offset);
                name = Buffer.from(r.bytes).toString('utf8');
                offset = r.next;
                break;
            }
            case 3: { // issuer (string)
                const r = readLengthDelimited(data, offset);
                issuer = Buffer.from(r.bytes).toString('utf8');
                offset = r.next;
                break;
            }
            case 4: { // algorithm (enum)
                const r = readVarint(data, offset);
                algorithm = MIGRATION_ALGORITHMS[Number(r.value)] || 'SHA1';
                offset = r.next;
                break;
            }
            case 5: { // digits (enum)
                const r = readVarint(data, offset);
                digits = MIGRATION_DIGITS[Number(r.value)] || 6;
                offset = r.next;
                break;
            }
            case 6: { // type (enum)
                const r = readVarint(data, offset);
                type = Number(r.value);
                offset = r.next;
                break;
            }
            default:
                offset = skipField(data, offset, wireType);
        }
    }

    if (!secret || type !== OTP_TYPE_TOTP) return null;

    // 拆分 issuer / accountName
    let accountName = name;
    let resolvedIssuer = issuer;
    if (name.includes(':')) {
        const parts = name.split(':');
        if (!resolvedIssuer) resolvedIssuer = parts[0].trim();
        accountName = parts.slice(1).join(':').trim();
    }
    const label = resolvedIssuer && accountName
        ? `${resolvedIssuer}:${accountName}`
        : (name || accountName || resolvedIssuer || 'TOTP');

    return {
        label,
        secret: base32Encode(secret),
        issuer: resolvedIssuer || '',
        accountName: accountName || '',
        algorithm,
        digits,
        period: 30
    };
}

/** 解析整个 MigrationPayload，返回 TOTP 账号数组和迁移批次元数据。 */
function parseMigrationPayload(data) {
    let offset = 0;
    const accounts = [];
    const metadata = {
        version: 0,
        batchSize: 1,
        batchIndex: 0,
        batchId: 0
    };

    while (offset < data.length) {
        const { value: tag, next } = readVarint(data, offset);
        offset = next;
        const fieldNumber = Number(tag >> 3n);
        const wireType = Number(tag & 0x7n);

        if (fieldNumber === 1 && wireType === 2) { // otp_parameters (repeated)
            const r = readLengthDelimited(data, offset);
            offset = r.next;
            const account = parseOtpParameters(r.bytes);
            if (account) accounts.push(account);
        } else if (wireType === 0 && fieldNumber >= 2 && fieldNumber <= 5) {
            const r = readVarint(data, offset);
            const value = Number(r.value);
            offset = r.next;
            if (fieldNumber === 2) metadata.version = value;
            if (fieldNumber === 3) metadata.batchSize = value || 1;
            if (fieldNumber === 4) metadata.batchIndex = value || 0;
            if (fieldNumber === 5) metadata.batchId = value || 0;
        } else {
            offset = skipField(data, offset, wireType);
        }
    }

    return { accounts, metadata };
}

function maskQrLocation(data, width, height, location) {
    if (!location) return false;

    const points = [
        location.topLeftCorner,
        location.topRightCorner,
        location.bottomRightCorner,
        location.bottomLeftCorner,
        location.topLeftFinderPattern,
        location.topRightFinderPattern,
        location.bottomLeftFinderPattern
    ].filter(Boolean);

    if (points.length === 0) return false;

    const minX = Math.max(0, Math.floor(Math.min(...points.map(p => p.x))));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(...points.map(p => p.x))));
    const minY = Math.max(0, Math.floor(Math.min(...points.map(p => p.y))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map(p => p.y))));
    const margin = Math.ceil(Math.max(maxX - minX, maxY - minY) * 0.04) + 8;
    const left = Math.max(0, minX - margin);
    const right = Math.min(width - 1, maxX + margin);
    const top = Math.max(0, minY - margin);
    const bottom = Math.min(height - 1, maxY + margin);

    for (let y = top; y <= bottom; y += 1) {
        for (let x = left; x <= right; x += 1) {
            const index = (y * width + x) * 4;
            data[index] = 255;
            data[index + 1] = 255;
            data[index + 2] = 255;
            data[index + 3] = 255;
        }
    }
    return true;
}

function decodeAllQrCodes(imageData, options = {}) {
    const workingData = new Uint8ClampedArray(imageData.data);
    const found = [];
    const seen = new Set();
    const maxCodes = options.maxCodes || 80;
    const inversionAttempts = options.inversionAttempts || 'attemptBoth';

    for (let i = 0; i < maxCodes; i += 1) {
        const code = jsQR(workingData, imageData.width, imageData.height, { inversionAttempts });
        if (!code) break;

        if (!seen.has(code.data)) {
            seen.add(code.data);
            found.push(code.data);
        }

        if (!maskQrLocation(workingData, imageData.width, imageData.height, code.location)) {
            break;
        }
    }

    return found;
}

function getTotpDedupKey(account) {
    return [
        account.secret || '',
        account.issuer || '',
        account.accountName || '',
        account.label || '',
        account.algorithm || 'SHA1',
        account.digits || 6,
        account.period || 30
    ].join('|').toLowerCase();
}

class QRCodeParser {
    constructor() {
        this.clipboardWatcher = null;
        this.lastClipboardContent = '';
        this.isWatching = false;
    }

    /**
     * 启动剪贴板监听
     */
    startClipboardWatcher(callback) {
        if (this.isWatching) {
            console.log('[QRCodeParser] Clipboard watcher already running');
            return;
        }

        this.isWatching = true;
        this.clipboardWatcher = setInterval(async () => {
            try {
                const image = clipboard.readImage();
                if (!image.isEmpty()) {
                    const dataUrl = image.toDataURL();
                    if (dataUrl !== this.lastClipboardContent) {
                        this.lastClipboardContent = dataUrl;
                        console.log('[QRCodeParser] Detected new image in clipboard');

                        const result = await this.parseImage(image);
                        if (result && callback) {
                            callback(result);
                        }
                    }
                }
            } catch (error) {
                console.error('[QRCodeParser] Error in clipboard watcher:', error);
            }
        }, 1000); // 每秒检查一次

        console.log('[QRCodeParser] Clipboard watcher started');
    }

    /**
     * 停止剪贴板监听
     */
    stopClipboardWatcher() {
        if (this.clipboardWatcher) {
            clearInterval(this.clipboardWatcher);
            this.clipboardWatcher = null;
            this.isWatching = false;
            console.log('[QRCodeParser] Clipboard watcher stopped');
        }
    }

    /**
     * 解析 Electron NativeImage
     */
    async parseImage(nativeImg) {
        try {
            // 转换为 Buffer
            const buffer = nativeImg.toPNG();

            // 使用 canvas 加载图片
            const img = await loadImage(buffer);

            // 创建 canvas
            const canvas = createCanvas(img.width, img.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            // 获取 ImageData
            const imageData = ctx.getImageData(0, 0, img.width, img.height);

            const codes = decodeAllQrCodes(imageData, { inversionAttempts: 'attemptBoth' });

            if (codes.length > 0) {
                console.log('[QRCodeParser] QR Codes detected from image:', codes.length);
                return this.parseQRCodeDataList(codes);
            } else {
                console.log('[QRCodeParser] No QR code found in image');
                return null;
            }
        } catch (error) {
            console.error('[QRCodeParser] Error parsing image:', error);
            return null;
        }
    }

    /**
     * 解析文件路径
     * 注意：canvas 的 loadImage(filePath) 在 Windows 下遇到中文/非 ASCII 路径会失败，
     * 因此这里先用 fs 读成 Buffer 再交给 loadImage，从 Buffer 加载不经过文件名编码。
     */
    async parseFile(filePath) {
        try {
            const buffer = fs.readFileSync(filePath);
            const img = await loadImage(buffer);

            const canvas = createCanvas(img.width, img.height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            const imageData = ctx.getImageData(0, 0, img.width, img.height);
            const codes = decodeAllQrCodes(imageData, { inversionAttempts: 'attemptBoth' });

            if (codes.length > 0) {
                console.log('[QRCodeParser] QR Codes detected from file:', codes.length);
                return this.parseQRCodeDataList(codes);
            } else {
                console.log('[QRCodeParser] No QR code found in file');
                return null;
            }
        } catch (error) {
            console.error('[QRCodeParser] Error parsing file:', error);
            throw error;
        }
    }

    /**
     * 解析二维码数据
     */
    parseQRCodeData(data) {
        if (data.startsWith('otpauth-migration://')) {
            return this.parseGoogleMigration(data);
        } else if (data.startsWith('otpauth://totp/')) {
            return this.parseStandardTotp(data);
        } else {
            const pairing = this.parseCodeBridgePairing(data);
            if (pairing) return pairing;
            return {
                type: 'unknown',
                data: data
            };
        }
    }

    parseQRCodeDataList(datas) {
        const uniqueDatas = Array.from(new Set((datas || []).filter(Boolean)));
        const results = uniqueDatas.map(data => this.parseQRCodeData(data)).filter(Boolean);
        return this.combineResults(results);
    }

    combineResults(results) {
        const validResults = (results || []).filter(Boolean);
        if (validResults.length === 0) return null;
        if (validResults.length === 1) return validResults[0];

        const accounts = [];
        const seenAccounts = new Set();
        const migrationBatches = [];
        let hasTotp = false;

        for (const result of validResults) {
            if (result.type === 'google-migration') {
                hasTotp = true;
                if (result.metadata) migrationBatches.push(result.metadata);
                for (const account of result.accounts || []) {
                    const key = getTotpDedupKey(account);
                    if (seenAccounts.has(key)) continue;
                    seenAccounts.add(key);
                    accounts.push(account);
                }
            } else if (result.type === 'standard-totp') {
                hasTotp = true;
                const key = getTotpDedupKey(result);
                if (!seenAccounts.has(key)) {
                    seenAccounts.add(key);
                    accounts.push(result);
                }
            }
        }

        if (hasTotp) {
            const expectedBatchSize = Math.max(1, ...migrationBatches.map(item => item.batchSize || 1));
            const seenBatchIndexes = Array.from(new Set(migrationBatches.map(item => item.batchIndex || 0)))
                .sort((a, b) => a - b);
            return {
                type: 'google-migration',
                accounts,
                count: accounts.length,
                sourceQrCount: validResults.length,
                metadata: {
                    batchSize: expectedBatchSize,
                    seenBatchIndexes,
                    seenBatchCount: seenBatchIndexes.length
                },
                incompleteBatch: expectedBatchSize > seenBatchIndexes.length,
                sourceTypes: validResults.map(result => result.type)
            };
        }

        return validResults[0];
    }

    async parseFiles(filePaths) {
        const results = [];
        for (const filePath of filePaths || []) {
            const result = await this.parseFile(filePath);
            if (result) results.push(result);
        }
        return this.combineResults(results);
    }

    /**
     * 解析 CodeBridge 桌面端配对二维码
     */
    parseCodeBridgePairing(data) {
        try {
            const parsed = JSON.parse(data);
            const protocol = String(parsed.protocol || '').toLowerCase();
            const deviceType = String(parsed.deviceType || parsed.type || '').toUpperCase();
            const isCodeBridge = protocol === 'codebridge-lan' || (parsed.pk && parsed.host && parsed.port);
            const isDesktop = deviceType.includes('DESKTOP') || deviceType.includes('WINDOWS') ||
                deviceType.includes('MAC') || deviceType.includes('LINUX');
            if (!isCodeBridge || !isDesktop) return null;

            return {
                type: 'codebridge-pairing',
                id: parsed.deviceId || parsed.id,
                name: parsed.name || parsed.deviceName || 'Desktop PC',
                deviceType: parsed.deviceType || parsed.type || 'WINDOWS_DESKTOP',
                host: parsed.host,
                port: Number(parsed.port),
                pairingKey: parsed.pk,
                protocol: parsed.protocol || 'codebridge-lan',
                topologyRole: parsed.topologyRole || 'target'
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * 解析 Google Authenticator 批量迁移
     * 直接在桌面端解码 MigrationPayload protobuf，提取所有 TOTP 账号。
     */
    parseGoogleMigration(url) {
        try {
            // 提取 data 参数（注意 base64 中的 +/= 在 URL 中可能被编码）
            const parsed = new URL(url);
            const dataParam = parsed.searchParams.get('data');
            if (!dataParam) {
                console.error('[QRCodeParser] No data parameter in migration URL');
                return null;
            }

            // Base64 解码（兼容 URL-safe 变体）
            const normalized = dataParam.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '+');
            const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
            const protobufData = Buffer.from(padded, 'base64');

            console.log('[QRCodeParser] Google migration data length:', protobufData.length);

            const parsedPayload = parseMigrationPayload(protobufData);
            const accounts = parsedPayload.accounts
                .filter(a => a.secret)
                .map(a => ({ type: 'standard-totp', ...a }));

            console.log('[QRCodeParser] Decoded migration accounts:', accounts.length, parsedPayload.metadata);

            return {
                type: 'google-migration',
                url: url,
                dataLength: protobufData.length,
                accounts: accounts,
                count: accounts.length,
                metadata: parsedPayload.metadata,
                incompleteBatch: (parsedPayload.metadata.batchSize || 1) > 1
            };
        } catch (error) {
            console.error('[QRCodeParser] Error parsing Google migration:', error);
            return null;
        }
    }

    /**
     * 解析标准 TOTP
     */
    parseStandardTotp(url) {
        try {
            const parsed = new URL(url);

            // 解析路径 (label)
            const label = decodeURIComponent(parsed.pathname.substring(1));

            // 解析查询参数
            const params = new URLSearchParams(parsed.search);

            const totp = {
                type: 'standard-totp',
                url: url,
                label: label,
                secret: params.get('secret'),
                issuer: params.get('issuer') || '',
                algorithm: params.get('algorithm') || 'SHA1',
                digits: parseInt(params.get('digits') || '6'),
                period: parseInt(params.get('period') || '30')
            };

            // 提取 issuer 和 accountName
            if (label.includes(':')) {
                const parts = label.split(':');
                totp.issuer = totp.issuer || parts[0].trim();
                totp.accountName = parts[1].trim();
            } else {
                totp.accountName = label;
            }

            console.log('[QRCodeParser] Parsed standard TOTP:', totp.label);
            return totp;
        } catch (error) {
            console.error('[QRCodeParser] Error parsing standard TOTP:', error);
            return null;
        }
    }
}

module.exports = new QRCodeParser();
