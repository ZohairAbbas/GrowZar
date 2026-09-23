export function meta() {
  return [{ title: "Growzar" }];
}

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-3xl font-semibold text-primary-500">Growzar</h1>
      <p className="mt-3 text-gray-600">
        One place for the apps you already run. Open Growzar from inside any of
        your apps to connect a store.
      </p>
    </main>
  );
}
