    import * as Google from 'expo-auth-session/providers/google';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import {
    GoogleAuthProvider,
    createUserWithEmailAndPassword,
    signInWithCredential,
    signInWithEmailAndPassword,
    updateProfile,
    type AuthError,
} from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';

    import { ensureBankAccountForUser } from '@/lib/bank';
import { auth, db, firebaseConfigured, missingFirebaseEnvKeys } from '@/lib/firebase';

    WebBrowser.maybeCompleteAuthSession();

    type GoogleProfile = {
    name?: string;
    email?: string;
    picture?: string;
    };

    function getAuthErrorMessage(error: unknown): string {
    const code = (error as AuthError | undefined)?.code;

    switch (code) {
        case 'auth/invalid-api-key':
            return 'Invalid Firebase API key. Check EXPO_PUBLIC_FIREBASE_API_KEY.';
        case 'auth/configuration-not-found':
            return 'Authentication provider is not enabled in Firebase Console.';
        case 'auth/operation-not-allowed':
            return 'This sign-in method is disabled in Firebase Authentication.';
        case 'auth/network-request-failed':
            return 'Network error. Check internet connection and try again.';
        case 'auth/invalid-credential':
            return 'Invalid credential. Verify Google client IDs in Firebase and Expo env.';
        case 'auth/user-not-found':
            return 'No account found for this email.';
        case 'auth/wrong-password':
        case 'auth/invalid-login-credentials':
            return 'Incorrect email or password.';
        case 'auth/email-already-in-use':
            return 'Email already in use. Try logging in instead.';
        case 'auth/weak-password':
            return 'Password is too weak. Use at least 6 characters.';
        case 'auth/invalid-email':
            return 'Invalid email address format.';
        default:
            return error instanceof Error ? error.message : 'Authentication failed';
    }
    }

    export default function LoginScreen() {
        const router = useRouter();
    const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
    const [fullName, setFullName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [googleProfile, setGoogleProfile] = useState<GoogleProfile | null>(null);
    const [authLoading, setAuthLoading] = useState(false);
    const [loadingProfile, setLoadingProfile] = useState(false);
    const [authStatus, setAuthStatus] = useState<{ message: string; type: 'error' | 'success' } | null>(null);
    const [showSuccessScreen, setShowSuccessScreen] = useState(false);
    const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showStatus = (message: string, type: 'error' | 'success') => {
        setAuthStatus({ message, type });
        Alert.alert(type === 'error' ? 'Error' : 'Success', message);
    };

    const env = process.env;
    const webClientId = env?.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';
    const androidClientId = env?.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '';
    const iosClientId = env?.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
    const expoClientId = env?.EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID ?? '';

    const googleConfigReady = useMemo(() => {
        if (Platform.OS === 'web') {
            return true;
        }

        return Boolean(webClientId || androidClientId || iosClientId || expoClientId);
    }, [webClientId, androidClientId, iosClientId, expoClientId]);

    const [request, response, promptAsync] = Google.useAuthRequest({
        clientId: Platform.OS === 'web' ? webClientId || undefined : expoClientId || undefined,
        webClientId: webClientId || 'GOOGLE_WEB_CLIENT_ID_NOT_SET',
        androidClientId: androidClientId || 'GOOGLE_ANDROID_CLIENT_ID_NOT_SET',
        iosClientId: iosClientId || 'GOOGLE_IOS_CLIENT_ID_NOT_SET',
        scopes: ['profile', 'email'],
    });

    const onLoginSuccess = (message: string) => {
        setAuthStatus({ message, type: 'success' });
        setShowSuccessScreen(true);

        if (redirectTimerRef.current) {
            clearTimeout(redirectTimerRef.current);
        }

        redirectTimerRef.current = setTimeout(() => {
            router.replace('/(tabs)');
        }, 700);
    };

    const saveGoogleUserProfile = async (uid: string, name: string, emailAddress: string) => {
        try {
        await setDoc(
            doc(db, 'users', uid),
            {
            uid,
            name,
            email: emailAddress,
            provider: 'google',
            updatedAt: serverTimestamp(),
            createdAt: serverTimestamp(),
            },
            { merge: true }
        );

        return true;
        } catch {
        return false;
        }
    };

    useEffect(() => {
        return () => {
            if (redirectTimerRef.current) {
                clearTimeout(redirectTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        const loadGoogleProfile = async () => {
        if (response?.type === 'error') {
            const responseParams = response.params as Record<string, string | undefined> | undefined;
            if (responseParams?.error === 'invalid_client') {
            showStatus(
                'Google OAuth client is invalid. For web, set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID from Google Cloud OAuth 2.0 Web Client and restart with: npx expo start -c',
                'error'
            );
            setLoadingProfile(false);
            return;
            }

            const details = responseParams?.error_description ?? responseParams?.error;
            showStatus(
            details ? `Google authentication error: ${details}` : 'Google authentication returned an error.',
            'error'
            );
            setLoadingProfile(false);
            return;
        }

        if (response?.type === 'dismiss') {
            showStatus('Google sign-in was cancelled.', 'error');
            setLoadingProfile(false);
            return;
        }

        if (response?.type !== 'success') {
            setLoadingProfile(false);
            return;
        }

        const responseParams = response.params as Record<string, string | undefined> | undefined;
        const idToken = response.authentication?.idToken ?? responseParams?.id_token;
        const accessToken = response.authentication?.accessToken;

        if (!idToken && !accessToken) {
            showStatus('Google token is missing from auth response.', 'error');
            setLoadingProfile(false);
            return;
        }

        if (!firebaseConfigured) {
            showStatus(`Firebase not configured. Missing env keys: ${missingFirebaseEnvKeys.join(', ')}`, 'error');
            setLoadingProfile(false);
            return;
        }

        if (!auth) {
            showStatus('Authentication is not available on this device right now.', 'error');
            setLoadingProfile(false);
            return;
        }

        try {
            setLoadingProfile(true);
            const credential = GoogleAuthProvider.credential(idToken, accessToken);
            const result = await signInWithCredential(auth, credential);

            const profile: GoogleProfile = {
            name: result.user.displayName ?? undefined,
            email: result.user.email ?? undefined,
            picture: result.user.photoURL ?? undefined,
            };

            const savedProfile = await saveGoogleUserProfile(
            result.user.uid,
            result.user.displayName ?? '',
            result.user.email ?? ''
            );
            await ensureBankAccountForUser(result.user.uid);

            setGoogleProfile(profile);
            onLoginSuccess(
            savedProfile
                ? `Welcome ${profile.name ?? profile.email ?? 'User'}!`
                : `Welcome ${profile.name ?? profile.email ?? 'User'}! Signed in, but profile save is blocked by Firestore rules.`
            );
        } catch (error) {
            showStatus(getAuthErrorMessage(error), 'error');
        } finally {
            setLoadingProfile(false);
        }
        };

        loadGoogleProfile();
    }, [response]);

    const onEmailAuth = async () => {
        setAuthStatus(null);

        if (!firebaseConfigured) {
        showStatus(`Firebase not configured. Missing env keys: ${missingFirebaseEnvKeys.join(', ')}`, 'error');
        return;
        }

        if (!email.trim() || !password.trim()) {
        showStatus('Please enter email and password.', 'error');
        return;
        }

        if (!auth) {
        showStatus('Authentication is not available on this device right now.', 'error');
        return;
        }

        try {
        setAuthLoading(true);

        if (authMode === 'signup') {
            if (!fullName.trim()) {
            showStatus('Please enter your full name.', 'error');
            return;
            }

            if (password !== confirmPassword) {
            showStatus('Password and confirm password must match.', 'error');
            return;
            }

            const created = await createUserWithEmailAndPassword(auth, email.trim(), password);
            await updateProfile(created.user, { displayName: fullName.trim() });

            await setDoc(
            doc(db, 'users', created.user.uid),
            {
                uid: created.user.uid,
                name: fullName.trim(),
                email: email.trim(),
                provider: 'password',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
            },
            { merge: true }
            );

            await ensureBankAccountForUser(created.user.uid);

            onLoginSuccess(`Account created for ${fullName.trim()}.`);
            return;
        }

        await signInWithEmailAndPassword(auth, email.trim(), password);
        if (auth.currentUser?.uid) {
            await ensureBankAccountForUser(auth.currentUser.uid);
        }
        onLoginSuccess(`Signed in as ${email.trim()}.`);
        } catch (error) {
        showStatus(getAuthErrorMessage(error), 'error');
        } finally {
        setAuthLoading(false);
        }
    };

    const onGoogleLogin = async () => {
        setAuthStatus(null);

        if (!auth) {
        showStatus('Authentication is not available on this device right now.', 'error');
        return;
        }

        if (Platform.OS === 'web') {
        try {
            setLoadingProfile(true);
            const { signInWithPopup } = await import('firebase/auth');
            const provider = new GoogleAuthProvider();
            const result = await signInWithPopup(auth, provider);

            const profile: GoogleProfile = {
            name: result.user.displayName ?? undefined,
            email: result.user.email ?? undefined,
            picture: result.user.photoURL ?? undefined,
            };

            const savedProfile = await saveGoogleUserProfile(
            result.user.uid,
            result.user.displayName ?? '',
            result.user.email ?? ''
            );
            await ensureBankAccountForUser(result.user.uid);

            setGoogleProfile(profile);
            onLoginSuccess(
            savedProfile
                ? `Welcome ${profile.name ?? profile.email ?? 'User'}!`
                : `Welcome ${profile.name ?? profile.email ?? 'User'}! Signed in, but profile save is blocked by Firestore rules.`
            );
        } catch (error) {
            showStatus(getAuthErrorMessage(error), 'error');
        } finally {
            setLoadingProfile(false);
        }
        return;
        }

        if (!googleConfigReady) {
        showStatus(
            'Google client ID missing. Add EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID (and platform IDs) in .env.local, then restart Expo with: npx expo start -c',
            'error'
        );
        return;
        }

        if (!request) {
        showStatus('Google sign-in is still initializing. Try again in a moment.', 'error');
        return;
        }

        try {
        setLoadingProfile(true);
        const promptResult = await promptAsync();
        if (promptResult.type !== 'success') {
            setLoadingProfile(false);
        }
        } catch {
        setLoadingProfile(false);
        showStatus('Unable to open Google login flow.', 'error');
        }
    };

    if (showSuccessScreen) {
        return (
        <View style={styles.successContainer}>
            <Text style={styles.successTitle}>Logged in</Text>
            <Text style={styles.successSubtitle}>{authStatus?.message ?? 'Redirecting...'}</Text>
        </View>
        );
    }

    return (
        <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.card}>
            <Text style={styles.title}>{authMode === 'login' ? 'Login' : 'Sign Up'}</Text>
            <Text style={styles.subtitle}>
            {authMode === 'login'
                ? 'Sign in with email or Google account'
                : 'Create account with email or Google account'}
            </Text>

            {authMode === 'signup' ? (
            <TextInput
                style={styles.input}
                placeholder="Full name"
                placeholderTextColor="#8a8aa3"
                value={fullName}
                onChangeText={setFullName}
            />
            ) : null}

            <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#8a8aa3"
            keyboardType="email-address"
            autoCapitalize="none"
            value={email}
            onChangeText={setEmail}
            />

            <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor="#8a8aa3"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
            />

            {authMode === 'signup' ? (
            <TextInput
                style={styles.input}
                placeholder="Confirm password"
                placeholderTextColor="#8a8aa3"
                secureTextEntry
                value={confirmPassword}
                onChangeText={setConfirmPassword}
            />
            ) : null}

            <TouchableOpacity style={styles.primaryButton} onPress={onEmailAuth} disabled={authLoading}>
            {authLoading ? (
                <ActivityIndicator color="#ffffff" />
            ) : (
                <Text style={styles.buttonText}>{authMode === 'login' ? 'Login' : 'Sign Up'}</Text>
            )}
            </TouchableOpacity>

            <TouchableOpacity
            style={[
                styles.googleButton,
                (loadingProfile || authLoading) && styles.buttonDisabled,
            ]}
            onPress={onGoogleLogin}
            disabled={loadingProfile || authLoading}>
            {loadingProfile ? (
                <ActivityIndicator color="#ffffff" />
            ) : (
                <Text style={styles.buttonText}>Continue with Google</Text>
            )}
            </TouchableOpacity>

            <TouchableOpacity
            style={styles.switchModeButton}
            onPress={() => {
                const nextMode = authMode === 'login' ? 'signup' : 'login';
                setAuthMode(nextMode);
                setPassword('');
                setConfirmPassword('');
                setAuthStatus(null);
            }}>
            <Text style={styles.switchModeText}>
                {authMode === 'login'
                ? "Don't have an account? Sign Up"
                : 'Already have an account? Login'}
            </Text>
            </TouchableOpacity>

            {googleProfile?.email ? (
            <Text style={styles.loggedInText}>Google: {googleProfile.email}</Text>
            ) : null}

            {authStatus ? (
            <Text style={[styles.statusText, authStatus.type === 'error' ? styles.statusError : styles.statusSuccess]}>
                {authStatus.message}
            </Text>
            ) : null}
        </View>
        </KeyboardAvoidingView>
    );
    }

    const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#1a1a2e',
        justifyContent: 'center',
        padding: 16,
    },
    successContainer: {
        flex: 1,
        backgroundColor: '#16a34a',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
    },
    successTitle: {
        color: '#ffffff',
        fontSize: 34,
        fontWeight: '800',
        marginBottom: 10,
    },
    successSubtitle: {
        color: '#ecfdf5',
        fontSize: 16,
        textAlign: 'center',
    },
    card: {
        backgroundColor: '#17172a',
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: '#2d2d4d',
    },
    title: {
        color: '#ffffff',
        fontSize: 28,
        fontWeight: '700',
        marginBottom: 6,
    },
    subtitle: {
        color: '#a0a0a0',
        marginBottom: 16,
    },
    input: {
        borderWidth: 1,
        borderColor: '#2d2d4d',
        borderRadius: 10,
        color: '#fff',
        backgroundColor: '#1a1a2e',
        paddingHorizontal: 12,
        paddingVertical: 10,
        marginBottom: 12,
    },
    primaryButton: {
        backgroundColor: '#5b58ff',
        borderRadius: 10,
        paddingVertical: 12,
        alignItems: 'center',
        marginBottom: 10,
    },
    googleButton: {
        backgroundColor: '#287d5a',
        borderRadius: 10,
        paddingVertical: 12,
        alignItems: 'center',
    },
    buttonDisabled: {
        opacity: 0.7,
    },
    buttonText: {
        color: '#fff',
        fontWeight: '700',
    },
    loggedInText: {
        color: '#b8f4d5',
        marginTop: 14,
        fontSize: 13,
    },
    switchModeButton: {
        alignItems: 'center',
        marginTop: 12,
    },
    switchModeText: {
        color: '#b8c2ff',
        fontSize: 13,
        fontWeight: '600',
    },
    statusText: {
        marginTop: 12,
        fontSize: 13,
        textAlign: 'center',
    },
    statusError: {
        color: '#ffb3b3',
    },
    statusSuccess: {
        color: '#b8f4d5',
    },
    });