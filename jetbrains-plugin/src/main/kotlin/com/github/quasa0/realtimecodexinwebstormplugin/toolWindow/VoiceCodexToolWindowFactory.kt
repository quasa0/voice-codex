package com.github.quasa0.realtimecodexinwebstormplugin.toolWindow

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser.createBuilder
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.callback.CefMediaAccessCallback.MediaPermissionFlags
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefPermissionHandler
import java.io.File
import javax.swing.JPanel

class VoiceCodexToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val component = if (JBCefApp.isSupported()) {
            val client = JBCefApp.getInstance().createClient()
            val browser = createBuilder()
                .setClient(client)
                .setUrl(VOICE_CODEX_EMBED_URL)
                .build()

            val openFileQuery = JBCefJSQuery.create(browser)
            openFileQuery.addHandler { requestedPath ->
                ApplicationManager.getApplication().invokeLater {
                    val normalizedPath = requestedPath.trim()
                    if (normalizedPath.isEmpty()) return@invokeLater

                    val ioFile = if (normalizedPath.startsWith("/")) {
                        File(normalizedPath)
                    } else {
                        val basePath = project.basePath ?: return@invokeLater
                        File(basePath, normalizedPath)
                    }

                    val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(ioFile)
                    if (virtualFile != null) {
                        FileEditorManager.getInstance(project).openFile(virtualFile, true)
                    }
                }

                null
            }

            client.addPermissionHandler(
                CefPermissionHandler { _, _, requestingUrl, requestedPermissions, callback ->
                    if (!requestingUrl.startsWith("http://localhost:5173")) {
                        callback.Cancel()
                        return@CefPermissionHandler true
                    }

                    val allowedPermissions =
                        requestedPermissions and
                            (MediaPermissionFlags.DEVICE_AUDIO_CAPTURE or MediaPermissionFlags.DEVICE_VIDEO_CAPTURE)

                    if (allowedPermissions == 0) {
                        callback.Cancel()
                    } else {
                        callback.Continue(allowedPermissions)
                    }
                    true
                },
                browser.cefBrowser,
            )

            client.addLoadHandler(
                object : CefLoadHandlerAdapter() {
                    override fun onLoadEnd(
                        cefBrowser: org.cef.browser.CefBrowser?,
                        frame: org.cef.browser.CefFrame?,
                        httpStatusCode: Int,
                    ) {
                        if (frame?.isMain != true || cefBrowser == null) return

                        cefBrowser.executeJavaScript(
                            """
                            window.IDEBridge = {
                              openFile: function(path) {
                                ${openFileQuery.inject("path")}
                              }
                            };
                            """.trimIndent(),
                            cefBrowser.url,
                            0,
                        )
                    }
                },
                browser.cefBrowser,
            )

            toolWindow.setTitleActions(
                listOf(
                    object : DumbAwareAction("Refresh", "Reload Voice Codex", AllIcons.Actions.Refresh) {
                        override fun actionPerformed(event: AnActionEvent) {
                            browser.cefBrowser.reload()
                        }
                    },
                ),
            )

            browser.component
        } else {
            JPanel().apply {
                toolTipText = "JCEF is not supported in this IDE runtime."
            }
        }

        val content = ContentFactory.getInstance().createContent(component, "", false)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project): Boolean = true

    companion object {
        private const val VOICE_CODEX_EMBED_URL = "http://localhost:5173?embed=true"
    }
}
