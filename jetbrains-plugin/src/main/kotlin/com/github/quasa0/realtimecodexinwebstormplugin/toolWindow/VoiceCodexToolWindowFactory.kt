package com.github.quasa0.realtimecodexinwebstormplugin.toolWindow

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.editor.markup.EffectType
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
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
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefPermissionHandler
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.awt.Component
import java.io.File
import javax.swing.JPanel
import javax.swing.SwingUtilities

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
                    focusFileInIde(project, IdeFocusTarget(path = normalizedPath), browser.component)
                }

                null
            }

            val focusFileQuery = JBCefJSQuery.create(browser)
            focusFileQuery.addHandler { rawPayload ->
                ApplicationManager.getApplication().invokeLater {
                    val target = parseFocusTarget(rawPayload)
                    if (target != null) {
                        focusFileInIde(project, target, browser.component)
                    }
                }

                null
            }

            val copyExportQuery = JBCefJSQuery.create(browser)
            copyExportQuery.addHandler { exportText ->
                val trimmed = exportText.trim()
                if (trimmed.isNotEmpty()) {
                    Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(trimmed), null)
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
                        cefBrowser: CefBrowser?,
                        frame: CefFrame?,
                        httpStatusCode: Int,
                    ) {
                        if (frame?.isMain != true || cefBrowser == null) return
                        val basePath = project.basePath ?: ""
                        val escapedBasePath = jsStringLiteral(basePath)

                        cefBrowser.executeJavaScript(
                            """
                            window.IDEBridge = {
                              projectPath: "${escapedBasePath}",
                              openFile: function(path) {
                                ${openFileQuery.inject("path")}
                              },
                              focusFile: function(target) {
                                const payload = [target?.path ?? "", target?.lineStart ?? "", target?.lineEnd ?? ""].join("\t");
                                ${focusFileQuery.inject("payload")}
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
                    object : DumbAwareAction("Copy Transcript", "Copy Realtime and Codex transcript text", AllIcons.Actions.Copy) {
                        override fun actionPerformed(event: AnActionEvent) {
                            browser.cefBrowser.executeJavaScript(
                                """
                                (() => {
                                  const text = typeof window.__VOICE_CODEX_COPY_LOGS__ === "function"
                                    ? window.__VOICE_CODEX_COPY_LOGS__()
                                    : typeof window.__VOICE_CODEX_EXPORT_TEXT__ === "function"
                                      ? window.__VOICE_CODEX_EXPORT_TEXT__()
                                    : (document.body?.innerText ?? "");
                                  ${copyExportQuery.inject("text")}
                                })();
                                """.trimIndent(),
                                browser.cefBrowser.url,
                                0,
                            )
                        }
                    },
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

        private fun jsStringLiteral(value: String): String =
            value
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")

        private fun parseFocusTarget(rawPayload: String): IdeFocusTarget? {
            val parts = rawPayload.split("\t")
            val path = parts.getOrNull(0)?.trim().orEmpty()
            if (path.isEmpty()) return null

            return IdeFocusTarget(
                path = path,
                lineStart = parts.getOrNull(1)?.trim()?.toIntOrNull(),
                lineEnd = parts.getOrNull(2)?.trim()?.toIntOrNull(),
            )
        }

        private fun focusFileInIde(project: Project, target: IdeFocusTarget, focusComponentToRestore: Component? = null) {
            val ioFile = if (target.path.startsWith("/")) {
                File(target.path)
            } else {
                val basePath = project.basePath ?: return
                File(basePath, target.path)
            }

            val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(ioFile) ?: return
            val fileEditorManager = FileEditorManager.getInstance(project)
            val zeroBasedLine = (target.lineStart ?: 1).coerceAtLeast(1) - 1
            val editor = fileEditorManager.openTextEditor(
                OpenFileDescriptor(project, virtualFile, zeroBasedLine, 0).setUseCurrentWindow(true),
                false,
            )
            if (editor == null) {
                fileEditorManager.openFile(virtualFile, false)
                restoreFocus(focusComponentToRestore)
                return
            }

            editor.scrollingModel.scrollToCaret(ScrollType.CENTER)

            val lineStart = target.lineStart ?: return
            val document = editor.document
            val maxLineIndex = document.lineCount.coerceAtLeast(1) - 1
            val startLineIndex = (lineStart - 1).coerceIn(0, maxLineIndex)
            val endLineIndex = ((target.lineEnd ?: lineStart) - 1).coerceIn(startLineIndex, maxLineIndex)
            val startOffset = document.getLineStartOffset(startLineIndex)
            val endOffset = document.getLineEndOffset(endLineIndex)

            val attributes = TextAttributes(
                null,
                java.awt.Color(185, 240, 117, 60),
                java.awt.Color(185, 240, 117, 180),
                EffectType.ROUNDED_BOX,
                java.awt.Font.PLAIN,
            )

            val highlighter = editor.markupModel.addRangeHighlighter(
                startOffset,
                endOffset,
                HighlighterLayer.SELECTION + 1,
                attributes,
                HighlighterTargetArea.EXACT_RANGE,
            )

            val timer = javax.swing.Timer(3500) {
                if (editor.isDisposed) return@Timer
                editor.markupModel.removeHighlighter(highlighter)
            }
            timer.isRepeats = false
            timer.start()
            restoreFocus(focusComponentToRestore)
        }

        private fun restoreFocus(component: Component?) {
            if (component == null) return
            SwingUtilities.invokeLater {
                component.requestFocusInWindow()
            }
        }
    }
}

private data class IdeFocusTarget(
    val path: String,
    val lineStart: Int? = null,
    val lineEnd: Int? = null,
)
