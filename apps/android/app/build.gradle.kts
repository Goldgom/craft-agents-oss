plugins {
    id("com.android.application")
}

val configuredServerUrl = providers.gradleProperty("serverUrl")
    .orElse("wss://agent.goldgom.top:50003")
    .get()

android {
    namespace = "com.craftagents.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.craftagents.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.1.0-community.1"

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

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}
