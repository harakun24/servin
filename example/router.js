export default {
  get() {
    return "Hellow!";
  },
  home: {
    get: () => "this is home",
    $id: {
      get: (id) => "this is id:" + id
    }
  }
}