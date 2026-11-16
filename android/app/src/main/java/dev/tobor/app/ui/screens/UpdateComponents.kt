package dev.tobor.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import dev.tobor.app.api.ToborApi
import dev.tobor.app.ui.theme.fieldTextStyle
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

/** Single-line bearer-token field: masked by default, with an eye toggle. Input is reduced to visible ASCII. */
@Composable
fun TokenField(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier) {
    var visible by remember { mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = { onValueChange(ToborApi.normalizeToken(it)) },
        modifier = modifier,
        textStyle = fieldTextStyle(),
        singleLine = true,
        placeholder = { Text("bearer token (optional)", style = fieldTextStyle()) },
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
        trailingIcon = {
            IconButton(onClick = { visible = !visible }) {
                Icon(
                    if (visible) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                    contentDescription = if (visible) "hide token" else "show token",
                    tint = ToborColors.muted,
                )
            }
        },
        colors = OutlinedTextFieldDefaults.colors(
            focusedTextColor = ToborColors.fg,
            unfocusedTextColor = ToborColors.fg,
            focusedBorderColor = ToborColors.gold,
            unfocusedBorderColor = ToborColors.border,
            cursorColor = ToborColors.gold,
            focusedContainerColor = ToborColors.sunken,
            unfocusedContainerColor = ToborColors.sunken,
            focusedPlaceholderColor = ToborColors.subtle,
            unfocusedPlaceholderColor = ToborColors.subtle,
        ),
    )
}

/**
 * Shown once when the node answers 401. [onSave] gets the entered token; [onDismiss] ("later") silences the prompt until
 * the node/token changes or a call succeeds, so polling and socket reconnects cannot re-open it in a loop.
 */
@Composable
fun TokenPromptDialog(
    workspaceName: String,
    hadToken: Boolean,
    onSave: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var token by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = ToborColors.raised,
        title = { Text("token required", fontFamily = FontFamilies.Righteous, fontSize = 18.sp, color = ToborColors.gold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    if (hadToken) {
                        "$workspaceName rejected the saved bearer token (401). Enter a new one."
                    } else {
                        "$workspaceName requires a bearer token (401). Enter it to connect."
                    },
                    fontFamily = FontFamilies.CourierPrime,
                    fontSize = 13.sp,
                    color = ToborColors.fg,
                )
                TokenField(token, { token = it }, Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(token) }, enabled = token.isNotEmpty()) {
                Text("save", fontFamily = FontFamilies.Righteous, color = ToborColors.gold)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("later", fontFamily = FontFamilies.Righteous, color = ToborColors.muted)
            }
        },
    )
}
