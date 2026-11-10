package dev.tobor.app.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class Workspace(val name: String, val baseUrl: String)

class SettingsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("tobor_settings", Context.MODE_PRIVATE)

    private val _workspacesFlow = MutableStateFlow<List<Workspace>>(emptyList())
    val workspacesFlow: StateFlow<List<Workspace>> = _workspacesFlow.asStateFlow()

    private val _activeIndexFlow = MutableStateFlow(0)
    val activeIndexFlow: StateFlow<Int> = _activeIndexFlow.asStateFlow()

    init {
        migrate()
        loadWorkspaces()
    }

    private fun migrate() {
        // Migration: if old baseUrl exists and workspaces don't exist yet, seed initial workspace
        if (prefs.contains(KEY_BASE_URL_LEGACY) && !prefs.contains(KEY_WORKSPACES)) {
            val oldUrl = prefs.getString(KEY_BASE_URL_LEGACY, null) ?: DEFAULT_BASE_URL
            val initial = listOf(Workspace("local", oldUrl))
            prefs.edit()
                .putString(KEY_WORKSPACES, Json.encodeToString(initial))
                .putInt(KEY_ACTIVE_INDEX, 0)
                .remove(KEY_BASE_URL_LEGACY)
                .apply()
        }
        // If nothing exists at all, seed default
        if (!prefs.contains(KEY_WORKSPACES)) {
            val initial = listOf(Workspace("local", DEFAULT_BASE_URL))
            prefs.edit()
                .putString(KEY_WORKSPACES, Json.encodeToString(initial))
                .putInt(KEY_ACTIVE_INDEX, 0)
                .apply()
        }
    }

    private fun loadWorkspaces() {
        val json = prefs.getString(KEY_WORKSPACES, null)
        if (json != null) {
            try {
                _workspacesFlow.value = Json.decodeFromString(json)
            } catch (_: Exception) {
                // Corrupted: reset to default
                _workspacesFlow.value = listOf(Workspace("local", DEFAULT_BASE_URL))
            }
        }
        _activeIndexFlow.value = prefs.getInt(KEY_ACTIVE_INDEX, 0).coerceIn(0, _workspacesFlow.value.size - 1)
    }

    private fun save() {
        prefs.edit()
            .putString(KEY_WORKSPACES, Json.encodeToString(_workspacesFlow.value))
            .putInt(KEY_ACTIVE_INDEX, _activeIndexFlow.value)
            .apply()
    }

    val workspaces: List<Workspace>
        get() = _workspacesFlow.value

    val active: Workspace
        get() {
            val idx = _activeIndexFlow.value.coerceIn(0, _workspacesFlow.value.size - 1)
            return _workspacesFlow.value.getOrElse(idx) { Workspace("local", DEFAULT_BASE_URL) }
        }

    val baseUrl: String
        get() = active.baseUrl

    fun add(ws: Workspace) {
        _workspacesFlow.value = _workspacesFlow.value + ws
        save()
    }

    fun remove(index: Int) {
        if (index in _workspacesFlow.value.indices && _workspacesFlow.value.size > 1) {
            _workspacesFlow.value = _workspacesFlow.value.filterIndexed { i, _ -> i != index }
            // If we removed the active one or something before it, adjust active index
            if (_activeIndexFlow.value >= _workspacesFlow.value.size) {
                _activeIndexFlow.value = _workspacesFlow.value.size - 1
            }
            save()
        }
    }

    fun update(index: Int, ws: Workspace) {
        if (index in _workspacesFlow.value.indices) {
            _workspacesFlow.value = _workspacesFlow.value.toMutableList().apply { this[index] = ws }
            save()
        }
    }

    fun setActive(index: Int) {
        if (index in _workspacesFlow.value.indices) {
            _activeIndexFlow.value = index
            save()
        }
    }

    companion object {
        const val DEFAULT_BASE_URL = "http://127.0.0.1:7879"
        private const val KEY_WORKSPACES = "workspaces"
        private const val KEY_ACTIVE_INDEX = "active_index"
        private const val KEY_BASE_URL_LEGACY = "base_url"
    }
}
