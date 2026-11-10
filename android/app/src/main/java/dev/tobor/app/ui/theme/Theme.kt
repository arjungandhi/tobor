package dev.tobor.app.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp

private val ToborColorScheme = darkColorScheme(
    primary = ToborColors.gold,
    onPrimary = ToborColors.bg,
    secondary = ToborColors.orange,
    onSecondary = ToborColors.bg,
    tertiary = ToborColors.teal,
    onTertiary = ToborColors.bg,
    background = ToborColors.bg,
    onBackground = ToborColors.fg,
    surface = ToborColors.surface,
    onSurface = ToborColors.fg,
    surfaceVariant = ToborColors.raised,
    onSurfaceVariant = ToborColors.muted,
    error = ToborColors.error,
    onError = ToborColors.bg,
    outline = ToborColors.border,
    outlineVariant = ToborColors.border,
)

private val ToborShapes = Shapes(
    extraSmall = RoundedCornerShape(3.dp),
    small = RoundedCornerShape(3.dp),
    medium = RoundedCornerShape(6.dp),
    large = RoundedCornerShape(6.dp),
    extraLarge = RoundedCornerShape(6.dp),
)

@Composable
fun ToborTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = ToborColorScheme,
        typography = ToborTypography,
        shapes = ToborShapes,
        content = content,
    )
}
