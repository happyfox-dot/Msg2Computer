# Google Authenticator 格式验证报告

## 📋 格式说明

### 官方格式（从搜索结果获得）

**URL Schema**:
```
otpauth-migration://offline?data=<URL_ENCODED_BASE64_PROTOBUF>
```

**Protobuf Schema**:
```protobuf
message MigrationPayload {
  enum Algorithm {
    ALGORITHM_UNSPECIFIED = 0;
    ALGORITHM_SHA1 = 1;
    ALGORITHM_SHA256 = 2;
    ALGORITHM_SHA512 = 3;
    ALGORITHM_MD5 = 4;
  }

  enum DigitCount {
    DIGIT_COUNT_UNSPECIFIED = 0;
    DIGIT_COUNT_SIX = 1;
    DIGIT_COUNT_EIGHT = 2;
  }

  enum OtpType {
    OTP_TYPE_UNSPECIFIED = 0;
    OTP_TYPE_HOTP = 1;
    OTP_TYPE_TOTP = 2;
  }

  message OtpParameters {
    bytes secret = 1;          // 原始字节（需转换为 Base32）
    string name = 2;           // 账号名称
    string issuer = 3;         // 发行者
    Algorithm algorithm = 4;   // 算法
    DigitCount digits = 5;     // 位数
    OtpType type = 6;          // 类型
    int64 counter = 7;         // HOTP 计数器
  }

  repeated OtpParameters otp_parameters = 1;
  int32 version = 2;
  int32 batch_size = 3;
  int32 batch_index = 4;
  int32 batch_id = 5;
}
```

**编码过程**:
1. Protobuf 序列化 → 二进制数据
2. Base64 编码
3. URL 编码（`+` → `%2B`, `/` → `%2F`, `=` → `%3D`）
4. 拼接为 `otpauth-migration://offline?data=...`

---

## ✅ 我们的实现验证

### GoogleAuthMigrationParser.kt 分析

**✅ 正确的部分**:
1. 支持 `otpauth-migration://` URL 解析
2. 实现了 Protobuf 手动解析（varint、length-delimited）
3. 支持 SHA1/SHA256/SHA512/MD5 算法映射
4. 支持 6/8 位验证码
5. 支持 TOTP/HOTP 类型
6. Secret 正确转换为 Base32 格式
7. 处理批量导入（batch_size/batch_index）

**🔍 需要验证的部分**:
1. **Protobuf 解析是否完全正确**
   - varint 解码
   - length-delimited 字段解析
   - 嵌套消息解析

2. **Secret 字节到 Base32 转换是否正确**
   - Google 导出的 secret 是原始字节
   - 需要转换为标准 Base32 字符串

---

## 🧪 测试建议

### 方法 1: 使用真实的 Google Authenticator 导出

1. 在 Google Authenticator 添加测试账号:
   ```
   账号1: GitHub (SHA1, 6位, 30秒)
   账号2: Google (SHA256, 6位, 30秒)  // 如果支持
   账号3: AWS (SHA1, 8位, 30秒)       // 如果支持
   ```

2. 导出为二维码
3. 用 CodeBridge 扫描
4. 验证:
   - 账号数量正确
   - 验证码与 Google Authenticator 一致
   - 参数（算法/位数）正确保存

### 方法 2: 使用在线工具生成测试数据

**工具推荐**:
- [Google Authenticator Migration Decoder](https://github.com/dim13/otpauth) - 命令行工具
- [otpauth-migration-decode](https://github.com/trewlgns/otpauth-migration-decode) - Web 工具

**测试步骤**:
1. 创建标准 otpauth URL
2. 使用工具转换为 otpauth-migration 格式
3. 生成二维码
4. 扫描测试

### 方法 3: 手动构造测试数据

创建简单的 protobuf 消息测试基本解析:

```python
# 伪代码示例
payload = MigrationPayload()
otp = payload.otp_parameters.add()
otp.secret = base64.b32decode("JBSWY3DPEHPK3PXP")
otp.name = "Test Account"
otp.issuer = "Test"
otp.algorithm = Algorithm.ALGORITHM_SHA1
otp.digits = DigitCount.DIGIT_COUNT_SIX
otp.type = OtpType.OTP_TYPE_TOTP

# 序列化并编码
data = base64.b64encode(payload.SerializeToString())
url = f"otpauth-migration://offline?data={quote(data)}"
```

---

## 📊 对比其他实现

### 参考项目
- [dim13/otpauth](https://github.com/dim13/otpauth) - Go 实现
- [digitalduke/otpauth-migration-decoder](https://github.com/digitalduke/otpauth-migration-decoder) - JavaScript 实现
- [johncallahan/otpauth_migration](https://github.com/johncallahan/otpauth_migration) - Dart 实现

### 共同特点
1. 所有实现都使用标准 protobuf 解析
2. Secret 从字节转换为 Base32
3. 算法映射：1=SHA1, 2=SHA256, 3=SHA512
4. 位数映射：1=6位, 2=8位

---

## ✅ 结论

**我们的实现应该是正确的**，因为：

1. ✅ Protobuf 格式匹配官方定义
2. ✅ 算法和位数枚举值正确
3. ✅ Secret 转换为 Base32
4. ✅ 支持批量导入
5. ✅ 错误处理完善

**唯一的验证方法是实际测试**：
- 用真实的 Google Authenticator 导出数据测试
- 对比验证码是否一致

---

## 📚 参考资源

- [Google Authenticator Export Format](https://zwyx.dev/blog/google-authenticator-export-format)
- [Parse Google Authenticator QR Codes](https://gist.github.com/jmiserez/744116545d7f595923966f883c4f1b5d)
- [dim13/otpauth](https://github.com/dim13/otpauth)
- [otpauth-migration-decode](https://github.com/trewlgns/otpauth-migration-decode)
- [Google Authenticator Migration Format](https://github.com/digitalduke/otpauth-migration-decoder)

---

**推荐测试流程**：
1. 使用真实的 Google Authenticator 导出 1-3 个账号
2. 用 CodeBridge 扫描批量导出的二维码
3. 验证导入的账号数量和验证码
4. 如果验证码不一致，检查算法映射和 Secret 转换

**我们的实现理论上是正确的，但需要实际测试验证！** ✅
