@ECHO OFF
SETLOCAL
SET APP_HOME=%~dp0
IF "%JAVA_HOME%"=="" GOTO findJavaFromPath
SET JAVA_EXE=%JAVA_HOME%\bin\java.exe
IF EXIST "%JAVA_EXE%" GOTO execute
:findJavaFromPath
SET JAVA_EXE=java.exe
:execute
"%JAVA_EXE%" -classpath "%APP_HOME%gradle\wrapper\gradle-wrapper.jar" org.gradle.wrapper.GradleWrapperMain %*
IF %ERRORLEVEL% NEQ 0 EXIT /B %ERRORLEVEL%
ENDLOCAL
