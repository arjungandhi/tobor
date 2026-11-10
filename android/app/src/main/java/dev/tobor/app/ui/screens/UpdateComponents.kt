package dev.tobor.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tobor.app.ui.theme.FontFamilies
import dev.tobor.app.ui.theme.ToborColors

/** Themed confirm/cancel dialog shared by the app-update prompt and the node upgrade/restart confirmations. */
@Composable
fun ConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    dismissLabel: String = "cancel",
    destructive: Boolean = false,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = ToborColors.raised,
        title = { Text(title, fontFamily = FontFamilies.Righteous, fontSize = 18.sp, color = ToborColors.gold) },
        text = { Text(message, fontFamily = FontFamilies.CourierPrime, fontSize = 13.sp, color = ToborColors.fg) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    confirmLabel,
                    fontFamily = FontFamilies.Righteous,
                    color = if (destructive) ToborColors.error else ToborColors.gold,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(dismissLabel, fontFamily = FontFamilies.Righteous, color = ToborColors.muted)
            }
        },
    )
}

@Composable
fun OutlinedAction(label: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        shape = RoundedCornerShape(4.dp),
        border = BorderStroke(1.dp, ToborColors.muted),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = ToborColors.fg),
    ) {
        Text(label, fontFamily = FontFamilies.Righteous, fontSize = 14.sp)
    }
}
