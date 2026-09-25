# THRIVE — Heat Health Risk Platform

THRIVE is a Vercel-hosted heat-health risk platform using the existing Open-Meteo weather flow, OpenStreetMap/OpenLayers map, nearby hospital/park discovery and the existing client-side heat-risk model.

## Registration flow

The public **Register** form submits directly to Formspree:

`https://formspree.io/f/xzdoyypp`

The submission includes:

- name, phone and email
- selected location and coordinates
- current THRIVE risk level and score
- risk explanation shown in the UI
- UTM attribution and landing URL
- explicit consent

The form keeps the existing THRIVE confirmation dialog and validation. Form submissions are handled manually from the Formspree inbox; the public form does not require Exotel or Supabase.

## Vercel deployment

```bash
npm run build   # copies the static frontend into dist/
vercel          # preview deploy
vercel --prod   # production deploy
```

`vercel.json` runs `npm run build` and serves `dist/`. Every file under `api/` is deployed as a Vercel Function at the matching `/api/...` URL (`api/_lib/` is shared code and is not exposed). Set environment variables in the Vercel dashboard or with `vercel env add` — see `.env.example`.

## Backend features

The frontend continues to use the existing client-side Open-Meteo/OpenStreetMap resource flow. The Vercel Functions in `api/` expose these endpoints:

- `/api/health`
- `/api/resources`
- `/api/register` (legacy Supabase storage path; public registration currently uses Formspree instead)
- `/api/location-ai`
- `/api/admin/*`
- `/api/alerts/*`
- `/api/webhooks/exotel/*`

The Exotel/Supabase alert backend is intentionally optional. You do not need it for the public Formspree-based registration workflow.

## Admin console

Open `/admin.html` directly and sign in with the `ADMIN_PASSWORD` configured in the Vercel project environment. The console is for authorized operations only.

When Supabase variables are present, it can list registered users, review alert records and run the existing server-side risk-triggered alert check manually. When Exotel variables are also present, the existing SMS/call controls and provider callback ledger can be used.

For the current manual Formspree workflow, the admin console is optional; Formspree is the operational inbox for new registration submissions.

## Heat-map image

The supplied India heat-map image is included as `india-heat-map.jpg` and is displayed in the existing **Heat can kill.** evidence section. The build script copies it into `dist/`.

## Privacy

The registration section explains that submitted information is processed by Formspree and may be retained by the THRIVE team for manual follow-up. Review the Formspree account settings and privacy controls attached to the endpoint for current retention details.

## Core frontend behavior preserved

The existing location search, automatic location flow, OpenLayers map, Open-Meteo weather data, heat-risk score, risk explanations, nearby hospitals/parks, evidence section, print/copy tools, responsive design and cookie preferences remain in place.
