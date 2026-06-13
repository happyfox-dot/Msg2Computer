plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

import java.util.Properties
import java.io.FileInputStream

// 加载签名配置（如果文件存在）
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    FileInputStream(keystorePropertiesFile).use { fis ->
        keystoreProperties.load(fis)
    }
}

android {
    namespace = "com.codesync"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.codesync"
        minSdk = 23
        targetSdk = 34
        versionCode = 32
        versionName = "1.0.32"
    }

    signingConfigs {
        create("release") {
            storeFile = file("../release/codebridge-release.jks")
            keyAlias = "codebridge"
            // PKCS12 格式：keyPassword 必须等于 storePassword
            // 优先级：环境变量 > keystore.properties > gradle.properties
            val password = System.getenv("KEYSTORE_PASSWORD")
                ?: keystoreProperties.getProperty("KEYSTORE_PASSWORD")
                ?: (project.findProperty("KEYSTORE_PASSWORD") as? String)
            storePassword = password
            keyPassword = password
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    implementation("com.google.zxing:core:3.5.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Protobuf for Google Authenticator migration support
    implementation("com.google.protobuf:protobuf-javalite:3.21.12")
}
