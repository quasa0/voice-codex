package com.github.quasa0.realtimecodexinwebstormplugin.toolWindow

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import javax.swing.JPanel

class VoiceCodexToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val component = if (JBCefApp.isSupported()) {
            JBCefBrowser(VOICE_CODEX_EMBED_URL).component
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
