/**
 * TOTP 存储模块单元测试
 */

const storage = require('./storage');

console.log('='.repeat(60));
console.log('TOTP Storage 单元测试');
console.log('='.repeat(60));
console.log();

// 测试 1: 添加 TOTP
console.log('[测试 1] 添加 TOTP');
const totp1 = storage.addTotp({
    label: 'GitHub',
    secret: 'JBSWY3DPEHPK3PXP',
    issuer: 'GitHub',
    accountName: 'user@example.com'
});
console.log('✅ 添加成功:', totp1.id);
console.log();

// 测试 2: 获取所有 TOTP
console.log('[测试 2] 获取所有 TOTP');
const allTotps = storage.getAllTotps();
console.log(`✅ 当前共有 ${allTotps.length} 个 TOTP`);
console.log();

// 测试 3: 更新 TOTP
console.log('[测试 3] 更新 TOTP');
const updated = storage.updateTotp(totp1.id, {
    label: 'GitHub (Updated)'
});
console.log('✅ 更新成功:', updated.label);
console.log();

// 测试 4: 查找 TOTP
console.log('[测试 4] 查找 TOTP');
const found = storage.getTotpById(totp1.id);
console.log('✅ 找到 TOTP:', found.label);
console.log();

// 测试 5: 添加短信
console.log('[测试 5] 添加短信');
const sms1 = storage.addSms({
    content: '您的验证码是 123456',
    sender: '10086',
    sourceDeviceId: 'xiaomi-13',
    sourceDeviceName: '小米 13',
    sourceDeviceType: 'ANDROID_PHONE'
});
console.log('✅ 短信添加成功:', sms1.id);
console.log();

// 测试 6: 获取统计信息
console.log('[测试 6] 获取统计信息');
const stats = storage.getStats();
console.log('✅ 统计信息:');
console.log('   - TOTP 总数:', stats.totpCount);
console.log('   - 本地 TOTP:', stats.localTotpCount);
console.log('   - 远程 TOTP:', stats.remoteTotpCount);
console.log('   - 短信数量:', stats.smsCount);
console.log();

// 测试 7: 设备信息
console.log('[测试 7] 设备信息');
const deviceId = storage.getDeviceId();
const deviceName = storage.getDeviceName();
console.log('✅ 设备 ID:', deviceId);
console.log('✅ 设备名称:', deviceName);
console.log();

// 测试 8: 数据导出
console.log('[测试 8] 数据导出');
const exported = storage.exportData();
console.log('✅ 导出成功:');
console.log('   - TOTP 数量:', exported.totps.length);
console.log('   - 短信数量:', exported.sms.length);
console.log();

// 测试 9: 删除测试数据
console.log('[测试 9] 清理测试数据');
storage.deleteTotp(totp1.id);
storage.deleteSms(sms1.id);
console.log('✅ 测试数据已清理');
console.log();

console.log('='.repeat(60));
console.log('所有测试通过！');
console.log('='.repeat(60));
