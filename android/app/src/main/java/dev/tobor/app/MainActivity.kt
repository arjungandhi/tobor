package dev.tobor.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import dev.tobor.app.api.ToborApi
import dev.tobor.app.data.SettingsStore
import dev.tobor.app.ui.screens.NewSessionScreen
import dev.tobor.app.ui.screens.artifacts.ArtifactsScreen
import dev.tobor.app.ui.screens.ScheduleFormScreen
import dev.tobor.app.ui.screens.SchedulesScreen
import dev.tobor.app.ui.screens.SessionScreen
import dev.tobor.app.ui.screens.SessionsScreen
import dev.tobor.app.ui.screens.SettingsScreen
import dev.tobor.app.ui.theme.ToborColors
import dev.tobor.app.ui.theme.ToborTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            ToborTheme {
                AppNav()
            }
        }
    }
}

@Composable
fun AppNav() {
    val context = LocalContext.current
    val store = remember { SettingsStore(context) }
    val api = remember { ToborApi(store.baseUrl) }
    val nav = rememberNavController()

    val activeBaseUrl by store.activeIndexFlow.collectAsState()

    LaunchedEffect(activeBaseUrl) {
        api.baseUrl = store.baseUrl
    }

    Box(Modifier.fillMaxSize().background(ToborColors.bg)) {
        NavHost(navController = nav, startDestination = "sessions") {
            composable("sessions") {
                // Key on activeBaseUrl so the screen fully restarts on workspace switch
                androidx.compose.runtime.key(activeBaseUrl) {
                    SessionsScreen(
                        api = api,
                        store = store,
                        onOpen = { id -> nav.navigate("session/$id") },
                        onNew = { nav.navigate("new") },
                        onSettings = { nav.navigate("settings") },
                        onSchedules = { nav.navigate("schedules") },
                        onArtifacts = { nav.navigate("artifacts") },
                    )
                }
            }
            composable("new") {
                NewSessionScreen(
                    api = api,
                    onCreated = { id -> nav.navigate("session/$id") { popUpTo("sessions") } },
                    onBack = { nav.popBackStack() },
                )
            }
            composable(
                "session/{id}",
                arguments = listOf(navArgument("id") { type = NavType.LongType }),
            ) { entry ->
                val id = entry.arguments?.getLong("id") ?: 0L
                SessionScreen(
                    api = api,
                    sessionId = id,
                    onBack = { nav.popBackStack() },
                    onOpenConversation = { cid -> nav.navigate("session/$cid") },
                )
            }
            composable("schedules") {
                SchedulesScreen(
                    api = api,
                    onOpenSession = { id -> nav.navigate("session/$id") },
                    onNew = { nav.navigate("schedules/new") },
                    onEdit = { id -> nav.navigate("schedules/edit/$id") },
                    onBack = { nav.popBackStack() },
                )
            }
            composable("schedules/new") {
                ScheduleFormScreen(
                    api = api,
                    onDone = { nav.popBackStack() },
                    onBack = { nav.popBackStack() },
                )
            }
            composable(
                "schedules/edit/{id}",
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) { entry ->
                ScheduleFormScreen(
                    api = api,
                    editId = entry.arguments?.getString("id"),
                    onDone = { nav.popBackStack() },
                    onBack = { nav.popBackStack() },
                )
            }
            composable("artifacts") {
                ArtifactsScreen(
                    api = api,
                    onBack = { nav.popBackStack() },
                )
            }
            composable("settings") {
                SettingsScreen(
                    api = api,
                    store = store,
                    onBack = { nav.popBackStack() },
                )
            }
        }
    }
}
