import java.io.File
import java.security.KeyStore
import java.security.PrivateKey
import java.util.Properties

plugins {
    id("com.android.application")
}

val configuredServerUrl = providers.gradleProperty("serverUrl")
    .orElse("wss://agent.goldgom.top:50003")
    .get()

// Credentials stay in the process environment or an ignored local file; never
// pass passwords via -P arguments (which appear in process listings and logs).
val signingPropertiesFile = rootProject.file(
    providers.gradleProperty("signingProperties")
        .orElse(providers.environmentVariable("ANDROID_SIGNING_PROPERTIES"))
        .orElse("signing.properties").get()
)
val signingProperties = Properties().apply {
    if (signingPropertiesFile.isFile) signingPropertiesFile.inputStream().use { load(it) }
}
fun signingValue(environment: String, property: String): String? =
    providers.environmentVariable(environment).orNull?.takeIf { it.isNotEmpty() }
        ?: signingProperties.getProperty(property)?.takeIf { it.isNotEmpty() }

val releaseStorePath = signingValue("ANDROID_KEYSTORE_PATH", "storeFile")
val releaseStoreFile = releaseStorePath?.let {
    val path = File(it)
    if (path.isAbsolute) path else signingPropertiesFile.parentFile.resolve(it)
}
val releaseStorePassword = signingValue("ANDROID_KEYSTORE_PASSWORD", "storePassword")
val releaseKeyAlias = signingValue("ANDROID_KEY_ALIAS", "keyAlias")
val releaseKeyPassword = signingValue("ANDROID_KEY_PASSWORD", "keyPassword")
val hasReleaseSigning = releaseStoreFile != null && releaseStorePassword != null &&
    releaseKeyAlias != null && releaseKeyPassword != null

val configuredVersionCode = providers.gradleProperty("versionCode")
    .orElse(providers.environmentVariable("ANDROID_VERSION_CODE")).orElse("5").get()
    .toIntOrNull()?.takeIf { it in 1..2100000000 }
    ?: throw GradleException("versionCode must be an integer between 1 and 2100000000.")
val configuredVersionName = providers.gradleProperty("versionName")
    .orElse(providers.environmentVariable("ANDROID_VERSION_NAME").map { it.ifBlank { "26.10.19" } })
    .orElse("26.10.19").get()
require(configuredVersionName.isNotBlank()) { "versionName must not be blank." }

val validateReleaseSigning = tasks.register("validateReleaseSigning") {
    group = "verification"
    description = "Validate release keystore and credentials without building assets."
    doLast {
        if (!hasReleaseSigning) {
            throw GradleException("Release signing is required. Set ANDROID_KEYSTORE_PATH, " +
                "ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD " +
                "or configure apps/android/signing.properties (see README.md).")
        }
        val storeFile = releaseStoreFile!!
        if (!storeFile.isFile) throw GradleException("Release keystore does not exist: $storeFile")
        try {
            val store = KeyStore.getInstance(storeFile, releaseStorePassword!!.toCharArray())
            if (!store.isKeyEntry(releaseKeyAlias) ||
                store.getKey(releaseKeyAlias, releaseKeyPassword!!.toCharArray()) !is PrivateKey ||
                store.getCertificate(releaseKeyAlias) == null) {
                throw IllegalArgumentException("Missing private key or certificate")
            }
        } catch (_: Exception) {
            throw GradleException("Cannot unlock the release signing key. Check keystore, alias, and passwords.")
        }
    }
}

// Guard direct Gradle release builds too, including invocations outside build.ps1.
tasks.configureEach {
    if (name == "preReleaseBuild" || name == "validateSigningRelease") {
        dependsOn(validateReleaseSigning)
    }
}

android {
    namespace = "com.tokenbird.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "top.goldgom.tokenbird"
        minSdk = 26
        targetSdk = 36
        versionCode = configuredVersionCode
        versionName = configuredVersionName
        manifestPlaceholders["appLabel"] = "@string/app_name"

        buildConfigField("String", "SERVER_URL", "\"${configuredServerUrl.replace("\\", "\\\\").replace("\"", "\\\"")}\"")

        // The bundled Bun runtime is currently available for Android ARM64.
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    packaging {
        jniLibs {
            // Extract the Bun executable into nativeLibraryDir so
            // ProcessBuilder can run it as a normal Android ELF executable.
            useLegacyPackaging = true
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseStoreFile
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            // Optional side-by-side installation when a device's existing APK
            // was signed with a different developer's debug key.
            applicationIdSuffix = providers.gradleProperty("debugApplicationIdSuffix").orNull
            if (!applicationIdSuffix.isNullOrBlank()) {
                manifestPlaceholders["appLabel"] = "词元鸟 · 调试"
            }
        }
        release {
            isDebuggable = false
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}
