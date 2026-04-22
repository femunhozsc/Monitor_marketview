# MarketView Monitor

Painel administrativo protegido por Firebase Auth do projeto `marketview-monitor`
e API serverless no Vercel. O navegador nao acessa mais o Firestore principal nem
o Cloudinary diretamente.

## Variaveis do Vercel

Configure no projeto Vercel do monitor:

```text
ADMIN_EMAILS=fernandomunhozsanga@gmail.com
MONITOR_FIREBASE_PROJECT_ID=marketview-monitor
MARKETVIEW_FIREBASE_PROJECT_ID=marketview-by-clearview
MONITOR_FIREBASE_SERVICE_ACCOUNT={JSON da service account do projeto marketview-monitor}
MARKETVIEW_FIREBASE_SERVICE_ACCOUNT={JSON da service account do projeto marketview-by-clearview}
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
REQUIRE_APP_CHECK=false
```

Depois que a site key do App Check web for inserida no `APP_CHECK_SITE_KEY` do
`index.html`, troque:

```text
REQUIRE_APP_CHECK=true
```

## Firebase Auth

1. No Firebase Console do projeto `marketview-monitor`, crie o usuario
   `fernandomunhozsanga@gmail.com`.
2. Em Authentication > Settings > Authorized domains, confirme que
   `marketview-monitor.vercel.app` esta autorizado.
3. O backend permite o email em `ADMIN_EMAILS`. Se quiser exigir custom claim,
   aplique `admin: true` nesse usuario e remova o fallback por email do backend.

## App Check

1. No projeto `marketview-monitor`, registre o dominio do monitor no App Check.
2. Copie a site key web do provedor escolhido.
3. Preencha `APP_CHECK_SITE_KEY` em `index.html`.
4. Publique e valide o login.
5. Ative `REQUIRE_APP_CHECK=true` no Vercel.

## Cloudinary

Os uploads e exclusoes passam pela API `/api/admin`, usando `CLOUDINARY_API_SECRET`
no servidor. Depois de publicar isso:

1. Desative ou restrinja o upload preset publico antigo.
2. Remova permissao de unsigned upload se nao for mais necessaria.
3. Restrinja formatos, tamanho e pastas permitidas no Cloudinary.
